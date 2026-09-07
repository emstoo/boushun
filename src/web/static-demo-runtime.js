import { createStaticRuntime } from "./api-client.js";

export const runtime = createStaticRuntime({ baseURL: new URL("./", import.meta.url) });
