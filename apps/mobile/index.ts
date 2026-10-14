import { registerRootComponent } from "expo";
import "./src/platform/install";
// Load shared Noise only after the native CSPRNG/encoding bridge is installed.
const App = require("./App").default;
registerRootComponent(App);
