import fs from "node:fs";
import path from "node:path";

export class JsonlStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  append(file: string, obj: unknown) {
    const p = path.join(this.dir, file);
    fs.appendFileSync(p, JSON.stringify(obj) + "\n", "utf8");
  }
}
