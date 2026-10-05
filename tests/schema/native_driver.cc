// SPDX-License-Identifier: MIT
#include "validator.h"
#include <cassert>
#include <iostream>
#include <limits>
#include <string>
using wfloat::schema::Json;
int main() {
    using namespace wfloat::schema;
    assert(!validate(true, std::numeric_limits<double>::infinity())["valid"].get<bool>());
    assert(!checkSchema({{"const", std::numeric_limits<double>::quiet_NaN()}})["valid"].get<bool>());
    assert(!validate(true, std::string("\xff"))["valid"].get<bool>());
    assert(!validate(true, Json::binary({1,2}))["valid"].get<bool>());
    std::string line;
    while (std::getline(std::cin, line)) {
        try {
            const auto request = Json::parse(line);
            const auto result = request.contains("value") ? validate(request.at("schema"), request.at("value")) : checkSchema(request.at("schema"));
            std::cout << result.dump() << '\n';
        } catch (const std::exception& e) {
            std::cerr << e.what() << '\n'; return 1;
        }
    }
}
