// @vitest-environment jsdom
//
// The Foodbuy step as one flow: fill in → Review (server-rendered PDF) → Send,
// with the same answers going to both routes. The canvas is stubbed: jsdom
// has no 2D context, and the pad only needs to produce a PNG data URL.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import FoodbuyOnboardStep from "@/components/customer/FoodbuyOnboardStep";
import { BUSINESS, CONTACT, SIGNATURE } from "@/lib/__tests__/foodbuyFixtures";
import type { MerchantApplication } from "@/types/merchant";

const APP = { id: "app-1", business: BUSINESS, ownerContact: CONTACT, foodbuyIds: null, aioTenant: null } as unknown as MerchantApplication;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  const ctx = {
    scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, clearRect() {}, drawImage() {},
    getImageData: (_x: number, _y: number, w: number, h: number) => {
      const data = new Uint8ClampedArray(w * h * 4);
      data[3] = 255; // one inked pixel
      return { data };
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => ctx as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => SIGNATURE);
  Element.prototype.setPointerCapture = vi.fn();
  // jsdom lays nothing out; the pad sizes its backing store from these.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(300);
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  window.scrollTo = vi.fn() as never;
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const type = (label: string, value: string, index = 0) =>
  fireEvent.change(screen.getAllByLabelText(label)[index], { target: { value } });

function fillIn() {
  type("Federal ID # (EIN)", "12-3456789");
  type("Distributor name/location", "Sysco Los Angeles");
  type("Account #", "168255");
  fireEvent.click(screen.getByLabelText(/No, we don't currently participate/));
  type("Contact name", "Miguel Perez", 2); // contacts 1 and 2 come first
  fireEvent.change(screen.getAllByLabelText("Phone")[2], { target: { value: "510-695-5147" } });
  fireEvent.change(screen.getAllByLabelText("Email")[2], { target: { value: "miguel@sysco.com" } });
  fireEvent.click(screen.getByRole("checkbox"));
  const pad = screen.getByLabelText(/Signature pad/);
  fireEvent.pointerDown(pad, { clientX: 5, clientY: 5 });
  fireEvent.pointerMove(pad, { clientX: 50, clientY: 20 });
  fireEvent.pointerUp(pad);
}

describe("FoodbuyOnboardStep", () => {
  it("pre-fills what AIO holds and leaves the EIN for the merchant", () => {
    render(<FoodbuyOnboardStep app={APP} />);
    expect(screen.getByLabelText("Legal entity name")).toHaveProperty("value", "Torta Palace LLC");
    expect(screen.getByLabelText("Federal ID # (EIN)")).toHaveProperty("value", "");
    expect(screen.getByLabelText("Restaurant location name")).toHaveProperty("value", "Torta Palace");
  });

  it("blocks review and marks what's missing", () => {
    render(<FoodbuyOnboardStep app={APP} />);
    fireEvent.click(screen.getByText("Review Agreement →"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Enter your 9-digit Federal ID # (EIN)")).toBeTruthy();
    expect(screen.getByText("Account # is required")).toBeTruthy();
    expect(screen.getByText("Sign the agreement")).toBeTruthy();
  });

  it("adds a distributor row at the same location", () => {
    render(<FoodbuyOnboardStep app={APP} />);
    fireEvent.click(screen.getByText("+ Add Distributor or Location"));
    const names = screen.getAllByLabelText("Restaurant location name");
    expect(names).toHaveLength(2);
    expect(names[1]).toHaveProperty("value", "Torta Palace");
    expect(screen.getAllByLabelText("Account #")[1]).toHaveProperty("value", "");
  });

  it("reviews the server-rendered agreement, then sends the same answers", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("%PDF-", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sent: true, sentAt: "2026-10-29T12:00:00Z" })));
    render(<FoodbuyOnboardStep app={APP} />);
    fillIn();
    fireEvent.click(screen.getByText("Review Agreement →"));

    await screen.findByTitle("Foodbuy participation agreement");
    const [previewUrl, previewInit] = fetchMock.mock.calls[0];
    expect(previewUrl).toBe("/api/customer/applications/app-1/foodbuy/preview");
    const answers = JSON.parse(previewInit.body);
    expect(answers.business.ein).toBe("12-3456789");
    expect(answers.locations[0]).toMatchObject({ distributor: "Sysco Los Angeles", acct: "168255" });
    expect(answers.signature).toBe(SIGNATURE);

    fireEvent.click(screen.getByText("Send to Foodbuy →"));
    await waitFor(() => expect(screen.getByText(/Sent to Foodbuy on/)).toBeTruthy());
    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe("/api/customer/applications/app-1/foodbuy/send");
    expect(sendInit.body).toBe(previewInit.body);
    expect(screen.queryByText("Send to Foodbuy →")).toBeNull();
  });

  it("explains when sending isn't set up", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("%PDF-", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ sent: false, reason: "not_configured" })));
    render(<FoodbuyOnboardStep app={APP} />);
    fillIn();
    fireEvent.click(screen.getByText("Review Agreement →"));
    fireEvent.click(await screen.findByText("Send to Foodbuy →"));
    expect(await screen.findByText(/Sending to Foodbuy isn't set up yet/)).toBeTruthy();
  });
});
