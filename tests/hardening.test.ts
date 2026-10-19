/** Input-validation and transport guards: each one closes a way for a fallible caller to do harm. */
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { describe, expect, it } from "vitest";

import { SevdeskApiError, SevdeskClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import {
  assertAllowedPath,
  optLimit,
  requireId,
  type ToolContext,
} from "../src/lib/tool.js";
import { MAX_OUTPUT_CHARS, capOutput, tools } from "../src/server.js";

type Row = Record<string, unknown>;
const env = (extra: Record<string, string>) => ({ SEVDESK_API_TOKEN: "t", ...extra });
const tool = (name: string) => tools.find((t) => t.name === name)!;

describe("config", () => {
  it("accepts https and loopback http, refuses cleartext elsewhere", () => {
    expect(loadConfig(env({ SEVDESK_BASE_URL: "https://proxy.example/api/v1/" })).baseUrl).toBe(
      "https://proxy.example/api/v1",
    );
    for (const u of ["http://localhost:8080/api", "http://127.0.0.1/api", "http://[::1]:9/api"]) {
      expect(loadConfig(env({ SEVDESK_BASE_URL: u })).baseUrl).toBe(u);
    }
    expect(() => loadConfig(env({ SEVDESK_BASE_URL: "http://example.com" }))).toThrow(/https/);
    expect(() => loadConfig(env({ SEVDESK_BASE_URL: "ftp://example.com" }))).toThrow(/https/);
    expect(() => loadConfig(env({ SEVDESK_BASE_URL: "not a url" }))).toThrow(/valid URL/);
  });

  it("splits receipt dirs on the platform delimiter and refuses relative entries", () => {
    const a = process.platform === "win32" ? "C:\\a" : "/a";
    const b = process.platform === "win32" ? "D:\\b" : "/b";
    expect(loadConfig(env({ SEVDESK_RECEIPT_DIRS: [a, b].join(delimiter) })).allowedReceiptDirs).toEqual([a, b]);
    expect(() => loadConfig(env({ SEVDESK_RECEIPT_DIRS: `${a}${delimiter}receipts` }))).toThrow(
      /not an absolute path/,
    );
  });
});

describe("client transport guards", () => {
  const cfg = loadConfig(env({ SEVDESK_RATE_LIMIT: "0" }));

  it("does not follow redirects and does not retry them", async () => {
    let calls = 0;
    let redirectMode: unknown;
    const client = new SevdeskClient(cfg, {
      fetchFn: (async (_u: unknown, init?: RequestInit) => {
        calls++;
        redirectMode = init?.redirect;
        return new Response(null, { status: 302, headers: { location: "https://evil.example/" } });
      }) as typeof fetch,
      sleep: async () => {},
    });
    const err = await client.request({ method: "GET", path: "/Voucher" }).catch((e) => e);
    expect(redirectMode).toBe("manual");
    expect(err).toBeInstanceOf(SevdeskApiError);
    expect(String(err.message)).toMatch(/redirect.*does not follow/is);
    expect(calls).toBe(1);
  });

  it("refuses a GET with a body up front, without calling fetch", async () => {
    let calls = 0;
    const client = new SevdeskClient(cfg, {
      fetchFn: (async () => {
        calls++;
        return new Response("{}");
      }) as typeof fetch,
    });
    await expect(client.request({ method: "GET", path: "/Voucher", body: { a: 1 } })).rejects.toThrow(
      /cannot carry a request body/,
    );
    expect(calls).toBe(0);
  });

  it("rejects '.' and '..' as path parameters", () => {
    expect(SevdeskClient.fillPath("/Voucher/{id}", { id: "42" })).toBe("/Voucher/42");
    expect(() => SevdeskClient.fillPath("/Voucher/{id}", { id: ".." })).toThrow(/Refused/);
    expect(() => SevdeskClient.fillPath("/Voucher/{id}", { id: "." })).toThrow(/Refused/);
  });
});

describe("arg helpers", () => {
  it("requireId accepts non-negative integers and digit strings only", () => {
    expect(requireId({ voucherId: 42 }, "voucherId")).toBe("42");
    expect(requireId({ voucherId: "0042" }, "voucherId")).toBe("0042");
    for (const bad of ["abc", "1/../2", "1?x=2", "-1", 1.5, -3, NaN, undefined, "", {}]) {
      expect(() => requireId({ voucherId: bad }, "voucherId")).toThrow("voucherId must be a numeric id.");
    }
  });

  it("optLimit floors and clamps to [1, max]", () => {
    expect(optLimit({}, "limit", 200, 1000)).toBe(200);
    expect(optLimit({ limit: -1 }, "limit", 200, 1000)).toBe(1);
    expect(optLimit({ limit: 0 }, "limit", 200, 1000)).toBe(1);
    expect(optLimit({ limit: 2.9 }, "limit", 200, 1000)).toBe(2);
    expect(optLimit({ limit: 1e9 }, "limit", 200, 1000)).toBe(1000);
    expect(optLimit({ limit: "abc" }, "limit", 200, 1000)).toBe(200);
  });
});

describe("assertAllowedPath", () => {
  it("follows symlinks: a link inside the allowlist pointing out is refused", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-sym-"));
    const allowed = join(root, "receipts");
    const outside = join(root, "secret");
    await mkdir(allowed);
    await mkdir(outside);
    await writeFile(join(outside, "key"), "secret");
    await writeFile(join(allowed, "ok.pdf"), "x");
    await symlink(join(outside, "key"), join(allowed, "link.pdf"));
    await symlink(outside, join(allowed, "linkdir"));
    const ctx = { config: { allowedReceiptDirs: [allowed] } } as unknown as ToolContext;

    await expect(assertAllowedPath(ctx, join(allowed, "ok.pdf"))).resolves.toMatch(/ok\.pdf$/);
    await expect(assertAllowedPath(ctx, join(allowed, "link.pdf"))).rejects.toThrow(/outside/);
    await expect(assertAllowedPath(ctx, join(allowed, "linkdir"))).rejects.toThrow(/outside/);
    await expect(assertAllowedPath(ctx, join(allowed, "..", "secret", "key"))).rejects.toThrow(/outside/);
    await expect(assertAllowedPath(ctx, join(allowed, "missing.pdf"))).rejects.toThrow(/Not found/);
  });

  it("accepts a symlinked allowlist entry when the target is inside its real path", async () => {
    const root = await mkdtemp(join(tmpdir(), "sevdesk-mcp-sym-"));
    const real = join(root, "real");
    await mkdir(real);
    await writeFile(join(real, "a.pdf"), "x");
    await symlink(real, join(root, "alias"));
    const ctx = { config: { allowedReceiptDirs: [join(root, "alias")] } } as unknown as ToolContext;
    await expect(assertAllowedPath(ctx, join(real, "a.pdf"))).resolves.toBe(join(real, "a.pdf"));
  });
});

describe("annotations and output cap", () => {
  it("only sevdesk_call is destructive", () => {
    expect(tools.filter((t) => t.destructive).map((t) => t.name)).toEqual(["sevdesk_call"]);
  });

  it("truncates oversized output with a final notice", () => {
    expect(capOutput("short")).toBe("short");
    const out = capOutput("x".repeat(MAX_OUTPUT_CHARS + 500));
    expect(out.startsWith("x".repeat(MAX_OUTPUT_CHARS))).toBe(true);
    expect(out).toMatch(
      new RegExp(`truncated at ${MAX_OUTPUT_CHARS} of ${MAX_OUTPUT_CHARS + 500} characters`),
    );
  });
});

describe("sevdesk_call guards", () => {
  const call = tool("sevdesk_call");
  function ctx(readOnly = false) {
    const sent: Array<{ method: string; path: string; query?: Row }> = [];
    return {
      sent,
      ctx: {
        client: {
          async request(o: { method: string; path: string; query?: Row }) {
            sent.push(o);
            return { status: 200, data: {} };
          },
        },
        config: { readOnly, dryRun: false, baseUrl: "https://example.test/api/v1" },
      } as unknown as ToolContext,
    };
  }

  it("requires numeric path parameters", async () => {
    const { ctx: c, sent } = ctx();
    for (const bad of ["..", "1/../2", "abc", "1?x"]) {
      await expect(
        call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: bad } }, c),
      ).rejects.toThrow(/numeric id/);
    }
    expect(sent).toHaveLength(0);
  });

  it("refuses a body on a GET operation, naming it", async () => {
    const { ctx: c } = ctx();
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 1 }, body: { a: 1 } }, c),
    ).rejects.toThrow(/invoiceGetPdf.*no request body/);
  });

  it("defaults preventSendBy to true on every operation that has it", async () => {
    const { ctx: c, sent } = ctx();
    for (const op of ["invoiceGetPdf", "creditNoteGetPdf", "orderGetPdf"]) {
      const idName = op === "invoiceGetPdf" ? "invoiceId" : op === "orderGetPdf" ? "orderId" : "creditNoteId";
      await call.handler({ operationId: op, params: { [idName]: 5 } }, c);
    }
    expect(sent.map((s) => s.query?.preventSendBy)).toEqual([true, true, true]);
  });

  it("refuses preventSendBy=false in read-only mode but allows it otherwise", async () => {
    const ro = ctx(true);
    await expect(
      call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 5, preventSendBy: false } }, ro.ctx),
    ).rejects.toThrow(/SEVDESK_READ_ONLY/);
    await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 5 } }, ro.ctx);
    expect(ro.sent[0]!.query?.preventSendBy).toBe(true);

    const rw = ctx(false);
    await call.handler({ operationId: "invoiceGetPdf", params: { invoiceId: 5, preventSendBy: false } }, rw.ctx);
    expect(rw.sent[0]!.query?.preventSendBy).toBe(false);
  });
});

describe("sevdesk_create_voucher validation", () => {
  const create = tool("sevdesk_create_voucher");
  const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
  const base = { supplierName: "A", voucherDate: "01.09.2026", taxRuleId: "9" };
  const run = (extra: Row) => create.handler({ ...base, ...extra }, c);

  it("requires a numeric taxRate, exactly one sum, and an allowed rate", async () => {
    await expect(run({ positions: [{ sumNet: 1 }] })).rejects.toThrow(/Position 1: taxRate/);
    await expect(run({ positions: [{ sumNet: 1, taxRate: "19" }] })).rejects.toThrow(/taxRate/);
    await expect(run({ positions: [{ taxRate: 19 }] })).rejects.toThrow(/exactly one of sumNet or sumGross/);
    await expect(run({ positions: [{ sumNet: 1, sumGross: 2, taxRate: 19 }] })).rejects.toThrow(/exactly one/);
    await expect(run({ positions: [{ sumNet: "1", taxRate: 19 }] })).rejects.toThrow(/sumNet must be/);
    await expect(run({ taxRuleId: "12", positions: [{ sumNet: 1, taxRate: 19 }] })).rejects.toThrow(
      /not allowed with rule 12/,
    );
    await expect(run({ positions: [{ sumGross: 119, taxRate: 19, accountingTypeId: "x" }] })).rejects.toThrow(
      /numeric id/,
    );
    const ok = (await run({ positions: [{ sumGross: 119, taxRate: 19 }] })) as {
      wouldSend: { body: { voucherPosSave: Row[] } };
    };
    expect(ok.wouldSend.body.voucherPosSave[0]).toMatchObject({ net: false, sumGross: 119, taxRate: 19 });
  });

  it("refuses extra keys that collide with fields the tool sets", async () => {
    const positions = [{ sumNet: 1, taxRate: 19 }];
    await expect(run({ positions, extra: { status: "1000", taxRule: {}, note: "x" } })).rejects.toThrow(
      /status, taxRule/,
    );
    const ok = (await run({ positions, extra: { note: "x" } })) as {
      wouldSend: { body: { voucher: Row } };
    };
    expect(ok.wouldSend.body.voucher.note).toBe("x");
  });
});

describe("sevdesk_create_invoice validation", () => {
  const create = tool("sevdesk_create_invoice");
  const c = { client: {}, config: { readOnly: false, dryRun: true } } as unknown as ToolContext;
  const run = (a: Row) => create.handler({ taxRuleId: "1", contactId: "7", ...a }, c);

  it("requires a numeric contactId, a non-empty name and a finite price", async () => {
    await expect(run({ contactId: "abc", positions: [{ name: "x", price: 1 }] })).rejects.toThrow(
      "contactId must be a numeric id.",
    );
    await expect(run({ positions: [{ name: "  ", price: 1 }] })).rejects.toThrow(/name must be/);
    await expect(run({ positions: [{ name: "x", price: "abc" }] })).rejects.toThrow(/price must be/);
    await expect(run({ positions: [{ name: "x" }] })).rejects.toThrow(/price must be/);
    await expect(run({ positions: [{ name: "x", price: 10 }] })).resolves.toMatchObject({ dryRun: true });
  });
});

describe("sevdesk_upload_voucher_file mime types", () => {
  const upload = tool("sevdesk_upload_voucher_file");

  it("maps known extensions and refuses unknown ones without mimeType", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sevdesk-mcp-mime-"));
    const c = {
      client: {},
      config: { readOnly: false, dryRun: true, allowedReceiptDirs: [dir] },
    } as unknown as ToolContext;
    const mimeOf = async (name: string, extra: Row = {}) => {
      await writeFile(join(dir, name), "x");
      const out = (await upload.handler({ filePath: join(dir, name), ...extra }, c)) as {
        wouldSend: { mime: string };
      };
      return out.wouldSend.mime;
    };
    expect(await mimeOf("a.XML")).toBe("application/xml");
    expect(await mimeOf("a.jpg")).toBe("image/jpeg");
    expect(await mimeOf("a.jpeg")).toBe("image/jpeg");
    expect(await mimeOf("a.pdf")).toBe("application/pdf");
    expect(await mimeOf("a.png")).toBe("image/png");
    await expect(mimeOf("a.heic")).rejects.toThrow(/mimeType/);
    expect(await mimeOf("a.heic", { mimeType: "image/heic" })).toBe("image/heic");
  });
});
