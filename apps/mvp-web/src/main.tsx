import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { consumePairingFragment } from "@flyx/client-core";
import { getWebHostRuntimes } from "./host-runtimes.js";
import { App } from "./app.js";
import "./styles.css";

// Remove one-time secrets synchronously, before rendering or starting any
// asynchronous network request. The core validates the captured offer before
// pinning the Host identity or sending the grant over an authenticated path.
const initialPairing = consumePairingFragment(window.location, window.history);
const runtimes = getWebHostRuntimes();
// Application ownership outlives every React observer mount and cleanup.
void runtimes.initialize(initialPairing).catch(() => undefined);
createRoot(document.getElementById("root")!).render(<StrictMode><App runtimes={runtimes} initialPairing={initialPairing} /></StrictMode>);
