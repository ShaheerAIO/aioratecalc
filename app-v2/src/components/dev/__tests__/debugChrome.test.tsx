// @vitest-environment jsdom
//
// DEBUG-SANDBOX / DEBUG-AUTO-LOGIN: debug-only test (branch debug/team-preview), never merge.
//
// The debug chrome the root layout mounts: the sandbox banner only with
// DEBUG_SANDBOX, the floating Rep/Admin switch only with
// ENABLE_DEBUG_ROLE_SWITCH, and the switch only on staff pages.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const push = vi.fn();
const refresh = vi.fn();
let pathname = "/rep";
const setDebugRoleAction = vi.fn(async () => {});
let cookie: string | undefined;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, refresh }),
  usePathname: () => pathname,
}));
vi.mock("@/lib/actions/debugRole", () => ({ setDebugRoleAction }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (cookie ? { name, value: cookie } : undefined) }),
}));

const { default: RootLayout } = await import("@/app/layout");
const { default: RoleSwitcher } = await import("@/components/dev/RoleSwitcher");
const { SANDBOX_BANNER_TEXT } = await import("@/components/dev/SandboxBanner");

const FLAGS = ["DEBUG_SANDBOX", "ENABLE_DEBUG_ROLE_SWITCH", "DEBUG_AUTO_LOGIN"] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  vi.clearAllMocks();
  for (const k of FLAGS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  pathname = "/rep";
  cookie = undefined;
});
afterEach(() => {
  cleanup();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

async function layoutHtml(): Promise<string> {
  return renderToStaticMarkup(await RootLayout({ children: <p>page</p> }));
}

describe("root layout", () => {
  it("no flags: neither the banner nor the switch", async () => {
    const html = await layoutHtml();
    expect(html).toContain("page");
    expect(html).not.toContain("DEBUG PREVIEW");
    expect(html).not.toContain("Debug role");
  });

  it("DEBUG_SANDBOX only: the banner, no switch", async () => {
    process.env.DEBUG_SANDBOX = "true";
    const html = await layoutHtml();
    expect(html).toContain(SANDBOX_BANNER_TEXT);
    expect(html).not.toContain("Debug role");
  });

  it("ENABLE_DEBUG_ROLE_SWITCH only: the switch, no banner", async () => {
    process.env.ENABLE_DEBUG_ROLE_SWITCH = "true";
    const html = await layoutHtml();
    expect(html).toContain("Debug role");
    expect(html).not.toContain("DEBUG PREVIEW");
  });

  it("all three: banner + switch, Rep selected by default, no 'Real session'", async () => {
    for (const k of FLAGS) process.env[k] = "true";
    const html = await layoutHtml();
    expect(html).toContain("DEBUG PREVIEW");
    expect(html).toMatch(/aria-pressed="true"[^>]*>Rep</);
    expect(html).not.toContain("Real session");
  });
});

describe("RoleSwitcher", () => {
  it("one click flips rep → admin and refreshes in place", async () => {
    render(<RoleSwitcher current="rep" autoLogin />);
    fireEvent.click(screen.getByRole("button", { name: "Admin" }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(setDebugRoleAction).toHaveBeenCalledWith("admin");
    expect(push).not.toHaveBeenCalled();
  });

  it("becoming a rep on an admin page moves to /rep", async () => {
    pathname = "/admin/settings/rate-matrix";
    render(<RoleSwitcher current="admin" autoLogin />);
    fireEvent.click(screen.getByRole("button", { name: "Rep" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/rep"));
    expect(setDebugRoleAction).toHaveBeenCalledWith("rep");
  });

  it.each(["/lead/tok-1", "/lead/tok-1/confirm", "/customer", "/customer/applications/x"])(
    "is not shown on the merchant's pages (%s)",
    path => {
      pathname = path;
      const { container } = render(<RoleSwitcher current="rep" autoLogin />);
      expect(container.innerHTML).toBe("");
    }
  );

  it("offers 'Real session' only without auto-login", () => {
    render(<RoleSwitcher current={null} />);
    expect(screen.getByRole("button", { name: "Real session" })).toBeTruthy();
  });
});
