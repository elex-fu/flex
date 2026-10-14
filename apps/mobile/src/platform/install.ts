import * as ExpoCrypto from "expo-crypto";
import { installNativeGlobals } from "./crypto";
installNativeGlobals({ fill: (value) => ExpoCrypto.getRandomValues(value) });
