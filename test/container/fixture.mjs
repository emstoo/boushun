import { execFileSync } from "node:child_process";
import { createServer } from "node:http";

// NET_ADMIN belongs only to this disposable fixture in a network_mode:none namespace.
execFileSync("ip", ["link", "add", "boushun0", "type", "dummy"]);
execFileSync("ip", ["link", "set", "dev", "boushun0", "address", "02:00:00:00:50:01"]);
execFileSync("ip", ["address", "add", "192.168.50.1/32", "dev", "boushun0"]);
execFileSync("ip", ["link", "set", "dev", "boushun0", "up"]);
createServer((_request, response) => response.end("synthetic fixture\n")).listen(45178, "0.0.0.0");
