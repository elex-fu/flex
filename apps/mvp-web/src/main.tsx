import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { consumePairingFragment } from "@flyx/client-core";
import { App } from "./app.js";
import "./styles.css";

// Remove one-time secrets synchronously, before rendering or starting any
// asynchronous network request. The core validates the captured offer before
// pinning the Host identity or sending the grant over an authenticated path.
const initialPairing = consumePairingFragment(window.location, window.history);
createRoot(document.getElementById("root")!).render(<StrictMode><App initialPairing={initialPairing} /></StrictMode>);
