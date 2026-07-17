// The shared /file + auto-send confinement (inventory.confinedFile). Every attack path must be
// refused; legit in-cwd files must resolve, with images flagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { confinedFile } from "../dist/core/inventory.js";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "confine-"));
  const cwd = path.join(root, "session");
  const outside = path.join(root, "outside");
  fs.mkdirSync(cwd); fs.mkdirSync(outside); fs.mkdirSync(path.join(cwd, "sub"));
  fs.writeFileSync(path.join(cwd, "notes.txt"), "hello");
  fs.writeFileSync(path.join(cwd, "chart.png"), "PNG");
  fs.writeFileSync(path.join(cwd, "sub", "data.json"), "{}");
  fs.writeFileSync(path.join(cwd, ".env"), "SECRET=1");
  fs.mkdirSync(path.join(cwd, ".ssh")); fs.writeFileSync(path.join(cwd, ".ssh", "id_rsa"), "KEY");
  fs.writeFileSync(path.join(cwd, "server.pem"), "CERT");
  fs.writeFileSync(path.join(outside, "loot.txt"), "sensitive");
  fs.symlinkSync(path.join(outside, "loot.txt"), path.join(cwd, "escape.txt"));
  fs.writeFileSync(path.join(cwd, "big.bin"), Buffer.alloc(21 * 1024 * 1024));
  return { root, cwd };
}

test("confinedFile: allows in-cwd files, flags images, refuses every escape/secret/oversize", () => {
  const { root, cwd } = sandbox();
  try {
    const ok = (arg) => { const r = confinedFile(cwd, arg); assert.ok(!("error" in r), `${arg} should be allowed`); return r; };
    const no = (arg) => assert.ok("error" in confinedFile(cwd, arg), `${arg} should be refused`);

    ok("notes.txt");
    ok("sub/data.json");
    assert.equal(ok("chart.png").isImage, true, "png flagged as image");
    assert.equal(ok("notes.txt").isImage, false, "txt not an image");

    no("/etc/passwd");                 // absolute
    no("../outside/loot.txt");         // parent escape
    no("../../etc/hosts");             // deeper escape
    no("escape.txt");                  // symlink escape
    no(".env");                        // dotfile
    no(".ssh/id_rsa");                 // dotdir
    no("server.pem");                  // secret name
    no("sub");                         // directory
    no("nope.txt");                    // missing
    assert.ok("error" in confinedFile(cwd, "big.bin", 10 * 1024 * 1024), "oversize refused at 10MB cap");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
