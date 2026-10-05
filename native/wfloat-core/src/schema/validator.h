// SPDX-License-Identifier: MIT
// Original Wfloat implementation; see README.md for scope and provenance.
#pragma once
#include <nlohmann/json.hpp>

namespace wfloat::schema {
using Json = nlohmann::json;
// Both return {valid: bool, issues: [{code, message, instancePath, schemaPath}]}.
// JSON Pointer paths; empty string denotes root. First failure only.
// checkSchema rejects malformed/unsupported schemas even in unused branches.
Json checkSchema(const Json& schema);
// Always preflights schema. Invalid schemas use code="invalidSchema" or
// "unsupportedSchema", distinct from code="invalidValue". Does not coerce.
Json validate(const Json& schema, const Json& value);
}  // namespace wfloat::schema
