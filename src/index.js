import registerTelemetry from "./telemetry";
import Store from "./storage/store";
import "./utils/theme";
import "./react-components/styles/global.scss";

registerTelemetry("/home", "Hubs Home Page");

const store = new Store();
window.APP = { store };

document.location = "https://1729.com";
