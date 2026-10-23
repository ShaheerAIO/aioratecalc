// The HubSpot subscription opens in a NEW tab (product owner, 2026-10-23), so
// the merchant's own tab can go back to the quote, where the invoice link sits
// beside it. The URL only exists once the checkout route has published —
// 10–30 seconds after the click — and a browser blocks a window.open that
// late. So the tab is opened empty inside the click and pointed at the quote
// when it arrives. Null when the browser blocked even that: callers fall back
// to navigating the current tab, which is how it worked before.

export type PendingTab = { go: (url: string) => void; close: () => void };

export function openPendingTab(): PendingTab | null {
  const tab = window.open("", "_blank");
  if (!tab) return null;
  try {
    tab.document.title = "Opening your subscription…";
    tab.document.body.style.font = "16px system-ui, sans-serif";
    tab.document.body.style.padding = "3rem";
    tab.document.body.textContent = "Opening your subscription… this usually takes 10–30 seconds.";
  } catch {
    // Cosmetic only.
  }
  return {
    // No handle back to this page from HubSpot's — what rel="noopener" does for a link.
    go: url => { tab.opener = null; tab.location.href = url; },
    close: () => tab.close(),
  };
}
