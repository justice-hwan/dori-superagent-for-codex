import { request } from "node:http";

export function wakeBridge(socket: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const wake = request({ socketPath: socket, path: "/wake", method: "POST", timeout: 10000 }, (response) => {
      response.resume();
      response.once("end", () =>
        response.statusCode === 200 ? resolve() : reject(new TypeError("Bridge wake failed")),
      );
    });
    wake.once("timeout", () => wake.destroy(new TypeError("Bridge wake timed out")));
    wake.once("error", reject);
    wake.end();
  });
}
