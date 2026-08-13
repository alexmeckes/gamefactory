import React from "react";
import { createRoot } from "react-dom/client";
import FactoryConsole from "../../app/FactoryConsole";
import "../../app/globals.css";
import "./desktop.css";
import "../contracts";

const root = document.getElementById("root");
if (!root) throw new Error("Desktop renderer root is missing");
createRoot(root).render(<React.StrictMode><FactoryConsole desktop /></React.StrictMode>);
