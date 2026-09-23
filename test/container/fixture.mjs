import { createServer } from "node:http";

const port = Number(process.env.BOUSHUN_FIXTURE_PORT ?? 45178);
createServer((_request, response) => response.end("synthetic fixture\n")).listen(port, "0.0.0.0");
