// @vitest-environment jsdom
//
// The Foodbuy step as one flow: type on the agreement → Review (server-rendered
// PDF) → Send, with the same answers going to both routes. The canvas is stubbed: jsdom
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
  fireEvent.click(screen.getByLabelText(/NO, WE DO NOT CURRENTLY PARTICIPATE/));
  type("Contact name", "Miguel Perez", 2); // contacts 1 and 2 come first
  fireEvent.change(screen.getAllByLabelText("Phone")[2], { target: { value: "510-695-5147" } });
  fireEvent.change(screen.getAllByLabelText("Email")[2], { target: { value: "miguel@sysco.com" } });
  fireEvent.click(screen.getByLabelText("Accept the terms"));
  const pad = screen.getByLabelText(/Signature pad/);
  fireEvent.pointerDown(pad, { clientX: 5, clientY: 5 });
  fireEvent.pointerMove(pad, { clientX: 50, clientY: 20 });
  fireEvent.pointerUp(pad);
}

describe("FoodbuyOnboardStep", () => {
  it("pre-fills what AIO holds, with the EIN blank when none is on file", () => {
    render(<FoodbuyOnboardStep app={APP} />);
    expect(screen.getByLabelText("Legal entity name")).toHaveProperty("value", "Torta Palace LLC");
    expect(screen.getByLabelText("Federal ID # (EIN)")).toHaveProperty("value", "");
    expect(screen.getAllByLabelText("Restaurant location name")[0]).toHaveProperty("value", "Torta Palace");
  });

  it("pre-fills the EIN given on the confirmation step, and it stays editable", () => {
    render(<FoodbuyOnboardStep app={{ ...APP, business: { ...BUSINESS, ein: "98-7654321" } }} />);
    expect(screen.getByLabelText("Federal ID # (EIN)")).toHaveProperty("value", "98-7654321");
    type("Federal ID # (EIN)", "12-3456789");
    expect(screen.getByLabelText("Federal ID # (EIN)")).toHaveProperty("value", "12-3456789");
  });

  it("blocks review and marks what's missing", () => {
    render(<FoodbuyOnboardStep app={APP} />);
    fireEvent.click(screen.getByText("Review Agreement →"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Enter your 9-digit Federal ID # (EIN)")).toBeTruthy();
    expect(screen.getByText("Line 1: Account # is required")).toBeTruthy();
    expect(screen.getByText("Sign the agreement")).toBeTruthy();
  });

  it("shows the agreement's blank table lines, and checks a line typed further down as its own row", () => {
    render(<FoodbuyOnboardStep app={APP} />);
    const names = screen.getAllByLabelText("Restaurant location name");
    expect(names).toHaveLength(10);
    expect(names[1]).toHaveProperty("value", "");
    type("Account #", "555", 3);
    fireEvent.click(screen.getByText("Review Agreement →"));
    expect(screen.getAllByLabelText("Restaurant location name")[3].getAttribute("aria-invalid")).toBe("true");
    expect(screen.getAllByLabelText("Restaurant location name")[1].getAttribute("aria-invalid")).toBe("false");
    expect(screen.getByText("Line 4: Location name is required")).toBeTruthy();
    fireEvent.click(screen.getByText("+ More lines"));
    expect(screen.getAllByLabelText("Restaurant location name")).toHaveLength(20);
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
    expect(answers.locations).toHaveLength(1); // blank lines are left out
    expect(answers.locations[0]).toMatchObject({ distributor: "Sysco Los Angeles", acct: "168255" });
    expect(answers.directAgreements).toEqual([]);
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
