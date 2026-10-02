// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {NokorPass} from "../src/NokorPass.sol";
import {NokorRegistry} from "../src/NokorRegistry.sol";
import {NokorMoney} from "../src/NokorMoney.sol";
import {NokorAccess} from "../src/NokorAccess.sol";
import {NokorPoint} from "../src/NokorPoint.sol";

/// Deploys the five contracts and grants every operational role to one operator
/// address (the COTA Worker's relayer key).
///
/// PROTOTYPE ONLY: in production each role belongs to a different institution
/// (immigration issues passes, the central bank mints, site authorities run gates).
///
///   DEPLOYER_KEY=0x... OPERATOR=0x... DISPUTE_WINDOW=86400 \
///   forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_KEY");
        address operator = vm.envAddress("OPERATOR");
        uint64 disputeWindow = uint64(vm.envOr("DISPUTE_WINDOW", uint256(1 days)));
        address admin = vm.addr(deployerKey);

        vm.startBroadcast(deployerKey);
        NokorPass pass = new NokorPass(admin);
        NokorRegistry registry = new NokorRegistry(admin);
        NokorMoney kUSD = new NokorMoney("Khmer USD", "kUSD", 2, admin, pass, registry, disputeWindow);
        NokorMoney kRIEL = new NokorMoney("Khmer Riel", "kRIEL", 0, admin, pass, registry, disputeWindow);
        NokorAccess access = new NokorAccess(admin, pass, kUSD, kRIEL);
        NokorPoint point = new NokorPoint(admin, pass, 3 * 365 days);

        pass.grantRole(pass.ISSUER_ROLE(), operator);
        registry.grantRole(registry.MERCHANT_ADMIN_ROLE(), operator);
        kUSD.grantRole(kUSD.MINTER_ROLE(), operator);
        kUSD.grantRole(kUSD.OPERATOR_ROLE(), operator);
        kRIEL.grantRole(kRIEL.MINTER_ROLE(), operator);
        kRIEL.grantRole(kRIEL.OPERATOR_ROLE(), operator);
        access.grantRole(access.SITE_ADMIN_ROLE(), operator);
        access.grantRole(access.GATE_ROLE(), operator);
        point.grantRole(point.MINTER_ROLE(), operator);
        point.grantRole(point.REDEEMER_ROLE(), operator);

        // Exit controls by risk class: (extra hold, daily cash-out cap).
        kUSD.setRiskParameters(NokorRegistry.RiskClass.Established, 0, 0);
        kUSD.setRiskParameters(NokorRegistry.RiskClass.Standard, 0, 2_000_00); // $2,000/day
        kUSD.setRiskParameters(NokorRegistry.RiskClass.New, 2 days, 500_00); // $500/day
        kRIEL.setRiskParameters(NokorRegistry.RiskClass.Established, 0, 0);
        kRIEL.setRiskParameters(NokorRegistry.RiskClass.Standard, 0, 8_000_000);
        kRIEL.setRiskParameters(NokorRegistry.RiskClass.New, 2 days, 2_000_000);
        vm.stopBroadcast();

        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "NokorPass", address(pass));
        vm.serializeAddress(key, "NokorRegistry", address(registry));
        vm.serializeAddress(key, "kUSD", address(kUSD));
        vm.serializeAddress(key, "kRIEL", address(kRIEL));
        vm.serializeAddress(key, "NokorAccess", address(access));
        string memory json = vm.serializeAddress(key, "NokorPoint", address(point));
        vm.writeJson(json, string.concat("deployments/", vm.toString(block.chainid), ".json"));
        console.log("Deployed. Addresses written to deployments/%s.json", block.chainid);
    }
}
