import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";
import { DEBUG_ROLE_COOKIE, isDebugRoleSwitchEnabled } from "@/lib/auth/debugRole";
import { effectiveDebugRole, isDebugAutoLoginEnabled } from "@/lib/debug/autoLogin"; // DEBUG-AUTO-LOGIN: debug-only, never merge
import { isSandbox } from "@/lib/debug/sandbox"; // DEBUG-SANDBOX: debug-only, never merge
import RoleSwitcher from "@/components/dev/RoleSwitcher";
import SandboxBanner from "@/components/dev/SandboxBanner"; // DEBUG-SANDBOX: debug-only, never merge

export const metadata: Metadata = {
  title: "ClearRate — AIO Proposal Engine",
  description: "AIO payment processing proposal and onboarding tool",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // DEBUG-ROLE-SWITCHER: only ever mounted when ENABLE_DEBUG_ROLE_SWITCH=true
  // (a flag that must only live in a local .env.local — see debugRole.ts).
  const debugSwitchEnabled = isDebugRoleSwitchEnabled();
  // DEBUG-AUTO-LOGIN: debug-only, never merge (was parseDebugRole).
  const currentDebugRole = debugSwitchEnabled
    ? effectiveDebugRole((await cookies()).get(DEBUG_ROLE_COOKIE)?.value)
    : null;
  const sandbox = isSandbox(); // DEBUG-SANDBOX: debug-only, never merge

  return (
    <html lang="en">
      <body>
        {children}
        {sandbox && <SandboxBanner />}
        {debugSwitchEnabled && (
          <RoleSwitcher current={currentDebugRole} autoLogin={isDebugAutoLoginEnabled()} aboveBanner={sandbox} />
        )}
      </body>
    </html>
  );
}
