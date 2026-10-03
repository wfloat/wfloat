// SPDX-License-Identifier: MIT
#include "validator.h"
#include <cmath>
#include <set>
#include <string>

namespace wfloat::schema {
namespace {
constexpr unsigned maxDepth = 128;
constexpr size_t maxWork = 100000;
struct WorkLimit {};
std::string at(const std::string& path, const std::string& key) {
    std::string escaped;
    for (char c : key) escaped += c == '~' ? "~0" : c == '/' ? "~1" : std::string(1, c);
    return path + "/" + escaped;
}
Json ok() { return {{"valid", true}, {"issues", Json::array()}}; }
Json fail(const std::string& code, const std::string& message,
          const std::string& sp, const std::string& ip = "") {
    return {{"valid", false}, {"issues", Json::array({{
        {"code", code}, {"message", message}, {"instancePath", ip}, {"schemaPath", sp}}})}};
}
bool valid(const Json& result) { return result.at("valid").get<bool>(); }
bool finite(const Json& j) { return j.is_number() && std::isfinite(j.get<double>()); }
bool natural(const Json& j) {
    return finite(j) && j.get<double>() >= 0 && std::floor(j.get<double>()) == j.get<double>();
}
bool equal(const Json& a, const Json& b, size_t& work);
int compareNumber(const Json& a, const Json& b);
bool typeName(const Json& j) {
    static const std::set<std::string> names = {"null", "boolean", "object", "array", "number", "integer", "string"};
    return j.is_string() && names.count(j.get<std::string>());
}
// Reject non-JSON in-memory nlohmann values too (binary, discarded, NaN/Inf,
// invalid UTF-8). Bound recursion before serialization/recursive validation.
bool jsonValue(const Json& j, unsigned depth, size_t& work) {
    if (depth > maxDepth || ++work > maxWork || j.is_binary() || j.is_discarded()) return false;
    if (j.is_number() && !finite(j)) return false;
    if (j.is_string()) { try { (void)j.dump(); } catch (const Json::exception&) { return false; } }
    if (j.is_structured()) for (auto i = j.begin(); i != j.end(); ++i) {
        if (j.is_object()) { try { (void)Json(i.key()).dump(); } catch (const Json::exception&) { return false; } }
        if (!jsonValue(i.value(), depth + 1, work)) return false;
    }
    return true;
}
Json check(const Json& s, const std::string& p, unsigned depth, size_t& work) {
    if (++work > maxWork) throw WorkLimit{};
    if (depth > maxDepth) return fail("unsupportedSchema", "Schema nesting exceeds 128", p);
    if (s.is_boolean()) return ok();
    if (!s.is_object()) return fail("invalidSchema", "Schema must be an object or boolean", p);
    for (auto i = s.begin(); i != s.end(); ++i) {
        const auto& k = i.key(); const auto& v = i.value(); const auto q = at(p, k);
        bool good = true;
        if (k == "type") {
            good = typeName(v);
            if (v.is_array() && !v.empty()) {
                good = true; std::set<std::string> seen;
                for (const auto& t : v) {
                    if (!typeName(t) || !seen.insert(t.get<std::string>()).second) { good = false; break; }
                }
            }
        } else if (k == "properties" || k == "$defs") {
            good = v.is_object();
            if (good) for (auto c = v.begin(); c != v.end(); ++c) {
                auto r = check(c.value(), at(q, c.key()), depth + 1, work); if (!valid(r)) return r;
            }
        } else if (k == "items" || k == "additionalProperties" || k == "not") {
            auto r = check(v, q, depth + 1, work); if (!valid(r)) return r;
        } else if (k == "anyOf" || k == "allOf" || k == "oneOf") {
            good = v.is_array() && !v.empty();
            if (good) for (size_t n = 0; n < v.size(); ++n) {
                auto r = check(v[n], at(q, std::to_string(n)), depth + 1, work); if (!valid(r)) return r;
            }
        } else if (k == "required") {
            good = v.is_array(); std::set<std::string> seen;
            if (good) for (const auto& name : v) {
                if (!name.is_string() || !seen.insert(name.get<std::string>()).second) { good = false; break; }
            }
        } else if (k == "enum") {
            good = v.is_array() && !v.empty();
            if (good) for (size_t a = 0; a < v.size(); ++a) for (size_t b = 0; b < a; ++b)
                if (equal(v[a], v[b], work)) good = false;
        } else if (k == "const" || k == "default") {
            // Annotation default never inserts a value.
        } else if (k == "examples") good = v.is_array();
        else if (k == "minimum" || k == "maximum" || k == "exclusiveMinimum" || k == "exclusiveMaximum") good = finite(v);
        else if (k == "multipleOf") good = finite(v) && v.get<double>() > 0;
        else if (k == "minLength" || k == "maxLength" || k == "minItems" || k == "maxItems" || k == "minProperties" || k == "maxProperties") good = natural(v);
        else if (k == "uniqueItems" || k == "readOnly" || k == "writeOnly" || k == "deprecated") good = v.is_boolean();
        else if (k == "title" || k == "description" || k == "$comment") good = v.is_string();
        else if (k == "$schema") {
            if (v != "https://json-schema.org/draft/2020-12/schema")
                return fail("unsupportedSchema", "Only the 2020-12 subset is supported", q);
        } else return fail("unsupportedSchema", "Unsupported keyword: " + k, q);
        if (!good) return fail("invalidSchema", "Invalid keyword value: " + k, q);
    }
    return ok();
}
bool matches(const Json& t, const Json& v) {
    if (t == "null") return v.is_null();
    if (t == "boolean") return v.is_boolean();
    if (t == "object") return v.is_object();
    if (t == "array") return v.is_array();
    if (t == "string") return v.is_string();
    if (t == "number") return v.is_number();
    return v.is_number() && (v.is_number_integer() || std::floor(v.get<double>()) == v.get<double>());
}
// Exact decimal divisibility of the JSON library's serialized numeric values.
// No epsilon that could accept a nearby non-multiple or a tiny nonzero value.
struct Decimal { std::string digits; int exponent; };
Decimal decimal(const Json& value) {
    auto s = value.dump(); if (s[0] == '-') s.erase(0, 1);
    const auto e = s.find_first_of("eE");
    int exponent = e == std::string::npos ? 0 : std::stoi(s.substr(e + 1));
    if (e != std::string::npos) s.resize(e);
    const auto dot = s.find('.');
    if (dot != std::string::npos) { exponent -= static_cast<int>(s.size() - dot - 1); s.erase(dot, 1); }
    auto first = s.find_first_not_of('0');
    s = first == std::string::npos ? "0" : s.substr(first);
    return {s, exponent};
}
bool ge(const std::string& a, const std::string& b) { return a.size() != b.size() ? a.size() > b.size() : a >= b; }
std::string subtract(std::string a, const std::string& b) {
    int borrow = 0;
    for (size_t n = 0; n < a.size(); ++n) {
        int digit = a[a.size()-1-n] - '0' - borrow - (n < b.size() ? b[b.size()-1-n]-'0' : 0);
        borrow = digit < 0; if (borrow) digit += 10;
        a[a.size()-1-n] = static_cast<char>('0' + digit);
    }
    const auto first = a.find_first_not_of('0'); return first == std::string::npos ? "0" : a.substr(first);
}
int compareNumber(const Json& left, const Json& right) {
    auto a = decimal(left); auto b = decimal(right);
    const bool negativeA = left.dump()[0] == '-' && a.digits != "0";
    const bool negativeB = right.dump()[0] == '-' && b.digits != "0";
    if (negativeA != negativeB) return negativeA ? -1 : 1;
    const auto scale = std::min(a.exponent, b.exponent);
    if (a.digits != "0") a.digits.append(static_cast<size_t>(a.exponent - scale), '0');
    if (b.digits != "0") b.digits.append(static_cast<size_t>(b.exponent - scale), '0');
    const int cmp = a.digits == b.digits ? 0 : ge(a.digits,b.digits) ? 1 : -1;
    return negativeA ? -cmp : cmp;
}
bool equal(const Json& a, const Json& b, size_t& work) {
    if (++work > maxWork) throw WorkLimit{};
    if (a.is_number() && b.is_number()) return compareNumber(a,b) == 0;
    if (a.type() != b.type() || a.size() != b.size()) return false;
    if (a.is_array()) {
        for (size_t n = 0; n < a.size(); ++n) if (!equal(a[n],b[n],work)) return false;
        return true;
    }
    if (a.is_object()) {
        for (auto i = a.begin(); i != a.end(); ++i) if (!b.contains(i.key()) || !equal(i.value(),b[i.key()],work)) return false;
        return true;
    }
    return a == b;
}
bool multiple(const Json& value, const Json& divisor) {
    auto a = decimal(value); auto b = decimal(divisor);
    if (a.digits == "0") return true;
    const auto scale = std::min(a.exponent, b.exponent);
    a.digits.append(static_cast<size_t>(a.exponent - scale), '0');
    b.digits.append(static_cast<size_t>(b.exponent - scale), '0');
    std::string rem = "0";
    for (char c : a.digits) {
        rem = rem == "0" ? std::string(1,c) : rem + c;
        while (ge(rem, b.digits)) rem = subtract(rem, b.digits);
    }
    return rem == "0";
}
Json run(const Json& s, const Json& v, const std::string& sp, const std::string& ip, size_t& work) {
    if (++work > maxWork) return fail("resourceLimit", "Validation work exceeds 100000 schema visits", sp, ip);
    auto bad = [&](const std::string& k, const std::string& m) { return fail("invalidValue", m, k.empty() ? sp : at(sp,k), ip); };
    if (s.is_boolean()) return s.get<bool>() ? ok() : bad("", "Value prohibited by false schema");
    if (s.contains("type")) {
        const auto& t = s["type"]; bool matched = false;
        if (t.is_array()) { for (const auto& name : t) matched |= matches(name, v); }
        else matched = matches(t, v);
        if (!matched) return bad("type", "Value does not match the allowed type");
    }
    if (s.contains("const") && !equal(s["const"], v, work)) return bad("const", "Value differs from const");
    if (s.contains("enum")) {
        bool found = false; for (const auto& e : s["enum"]) found |= equal(e, v, work);
        if (!found) return bad("enum", "Value is not in enum");
    }
    for (const auto* k : {"anyOf", "allOf", "oneOf"}) if (s.contains(k)) {
        size_t passed = 0;
        for (size_t n = 0; n < s[k].size(); ++n) {
            auto r = run(s[k][n], v, at(at(sp,k), std::to_string(n)), ip, work);
            if (!valid(r) && r["issues"][0]["code"] != "invalidValue") return r;
            passed += valid(r);
        }
        if ((std::string(k) == "anyOf" && passed == 0) || (std::string(k) == "allOf" && passed != s[k].size()) || (std::string(k) == "oneOf" && passed != 1)) return bad(k, "Value does not satisfy " + std::string(k));
    }
    if (s.contains("not")) {
        auto r = run(s["not"], v, at(sp,"not"), ip, work);
        if (valid(r)) return bad("not", "Value satisfies prohibited schema");
        if (r["issues"][0]["code"] != "invalidValue") return r;
    }
    if (v.is_number()) {
        for (const auto* k : {"minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"}) if (s.contains(k)) {
            const auto cmp = compareNumber(v, s[k]);
            const std::string key(k);
            if ((key == "minimum" && cmp < 0) || (key == "maximum" && cmp > 0) || (key == "exclusiveMinimum" && cmp <= 0) || (key == "exclusiveMaximum" && cmp >= 0)) return bad(k, "Numeric bound violated");
        }
        if (s.contains("multipleOf") && !multiple(v, s["multipleOf"])) return bad("multipleOf", "Value is not a multiple");
    }
    if (v.is_string() || v.is_array() || v.is_object()) {
        size_t length = v.size();
        const char* min = v.is_array() ? "minItems" : v.is_object() ? "minProperties" : "minLength";
        const char* max = v.is_array() ? "maxItems" : v.is_object() ? "maxProperties" : "maxLength";
        if (v.is_string()) { length = 0; for (unsigned char c : v.get_ref<const std::string&>()) if ((c & 0xc0) != 0x80) ++length; }
        if (s.contains(min) && static_cast<long double>(length) < s[min].get<long double>()) return bad(min, "Too few elements/code points");
        if (s.contains(max) && static_cast<long double>(length) > s[max].get<long double>()) return bad(max, "Too many elements/code points");
    }
    if (v.is_object()) {
        if (s.contains("required")) for (const auto& name : s["required"])
            if (!v.contains(name.get<std::string>())) return bad("required", "Missing property: " + name.get<std::string>());
        for (auto i = v.begin(); i != v.end(); ++i) {
            const Json* child = nullptr; std::string cp;
            if (s.contains("properties") && s["properties"].contains(i.key())) { child = &s["properties"][i.key()]; cp = at(at(sp,"properties"),i.key()); }
            else if (s.contains("additionalProperties")) { child = &s["additionalProperties"]; cp = at(sp,"additionalProperties"); }
            if (child) { auto r = run(*child,i.value(),cp,at(ip,i.key()),work); if (!valid(r)) return r; }
        }
    }
    if (v.is_array()) {
        if (s.value("uniqueItems", false)) for (size_t a = 0; a < v.size(); ++a) for (size_t b = 0; b < a; ++b) {
            if (++work > maxWork) return fail("resourceLimit", "Validation work limit exceeded", sp, ip);
            if (equal(v[a], v[b], work)) return bad("uniqueItems", "Duplicate array item");
        }
        if (s.contains("items")) for (size_t n = 0; n < v.size(); ++n) {
            auto r = run(s["items"], v[n], at(sp,"items"), at(ip,std::to_string(n)),work); if (!valid(r)) return r;
        }
    }
    return ok();
}
} // namespace
Json checkSchema(const Json& schema) {
    size_t work = 0;
    if (!jsonValue(schema,0,work)) return fail("invalidSchema", "Schema must be finite UTF-8 JSON within depth/work limits", "");
    work = 0;
    try { return check(schema,"",0,work); }
    catch (const WorkLimit&) { return fail("unsupportedSchema", "Schema comparison work exceeds 100000 visits", ""); }
}
Json validate(const Json& schema, const Json& value) {
    auto checked = checkSchema(schema); if (!valid(checked)) return checked;
    size_t work = 0;
    if (!jsonValue(value,0,work)) return fail("invalidValue", "Value must be finite UTF-8 JSON within depth/work limits", "");
    work = 0;
    try { return run(schema,value,"","",work); }
    catch (const WorkLimit&) { return fail("resourceLimit", "Validation work exceeds 100000 visits", ""); }
}
} // namespace wfloat::schema
