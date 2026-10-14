import { randomFillSync } from "node:crypto";
import { installNativeGlobals } from "./crypto";
// Executes real native-adapter primitives with an injected desktop CSPRNG.
// This proves provider/transcript compatibility, not execution on an actual phone.
installNativeGlobals({ fill: (value) => randomFillSync(value) });
