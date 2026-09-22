"use client";

import type React from "react";
import { isFromHubspotField, UNKNOWABLE_REVIEW_FIELDS, type AppliedReviewFields } from "@/lib/prefillMerge";
import type { BusinessInfo, OwnerContact, ProcessingInfo } from "@/types/merchant";
import styles from "./ReviewSection.module.css";

type Props = {
  business: BusinessInfo;
  ownerContact: OwnerContact;
  processing: ProcessingInfo;
  applied: AppliedReviewFields;
  // A marketing-only quote has no processing behind it at all — see
  // isProcessingQuote in quoting.ts — so the Processing Details panel is
  // dropped rather than shown with nothing useful in it.
  showProcessing: boolean;
  onBusinessChange: (next: BusinessInfo) => void;
  onOwnerChange: (next: OwnerContact) => void;
  onProcessingChange: (next: ProcessingInfo) => void;
};

const isUnknowable = (path: string) => UNKNOWABLE_REVIEW_FIELDS.includes(path);

/**
 * "Review What We Know" — renders BusinessInfo/OwnerContact/ProcessingInfo
 * prefilled from the linked HubSpot company (badged "from HubSpot"), fully
 * editable, so the rep confirms or corrects what used to be stamped onto the
 * application invisibly. Fields HubSpot structurally never has (mcc, bizType,
 * volume, ticket, …) read "HubSpot doesn't have this" instead of a silent
 * empty box — see hubspotPrefill.ts and prefillMerge.ts's
 * UNKNOWABLE_REVIEW_FIELDS for exactly which those are.
 *
 * Purely controlled — this component owns no state of its own, so the parent
 * (which also has to fold in the HubSpot prefill on a company switch) stays
 * the single source of truth for these three records.
 */
export default function ReviewSection({
  business, ownerContact, processing, applied, showProcessing,
  onBusinessChange, onOwnerChange, onProcessingChange,
}: Props) {
  const field = (
    path: string,
    labelText: string,
    value: string,
    onChange: (v: string) => void,
    opts: { placeholder?: string; type?: string } = {}
  ) => {
    const fromHubspot = !isUnknowable(path) && isFromHubspotField(applied, path, value);
    return (
      <div className={styles.field} key={path}>
        <label className={styles.label}>
          {labelText}
          {fromHubspot && <span className={styles.badgeHubspot}>from HubSpot</span>}
          {isUnknowable(path) && <span className={styles.badgeUnknown}>HubSpot doesn&apos;t have this</span>}
        </label>
        <input
          type={opts.type ?? "text"}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={opts.placeholder}
          className={styles.input}
        />
      </div>
    );
  };

  return (
    <div className={styles.wrap}>
      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Business Information</h2>
        <div className={styles.grid2}>
          {field("business.legalName", "Legal Business Name", business.legalName, v => onBusinessChange({ ...business, legalName: v }))}
          {field("business.dba", "DBA (Doing Business As)", business.dba, v => onBusinessChange({ ...business, dba: v }))}
        </div>
        <div className={styles.row}>
          <label className={styles.label}>
            Business Type
            <span className={styles.badgeUnknown}>HubSpot doesn&apos;t have this</span>
          </label>
          <select
            value={business.bizType}
            onChange={e => onBusinessChange({ ...business, bizType: e.target.value as BusinessInfo["bizType"] })}
            className={styles.input}
          >
            {(["llc", "corp", "s-corp", "sole-prop", "partnership", "non-profit"] as const).map(t => (
              <option key={t} value={t}>{t.replace("-", " ").replace(/\b\w/g, c => c.toUpperCase())}</option>
            ))}
          </select>
        </div>
        <div className={styles.row}>
          {field("business.address", "Street Address", business.address, v => onBusinessChange({ ...business, address: v }))}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {field("business.city", "City", business.city, v => onBusinessChange({ ...business, city: v }))}
          {field("business.state", "State", business.state, v => onBusinessChange({ ...business, state: v }), { placeholder: "CA" })}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {field("business.zip", "ZIP", business.zip, v => onBusinessChange({ ...business, zip: v }), { placeholder: "90210" })}
          {field("business.phone", "Business Phone", business.phone, v => onBusinessChange({ ...business, phone: v }), { placeholder: "555-000-0000" })}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {field("business.website", "Website", business.website, v => onBusinessChange({ ...business, website: v }), { placeholder: "https://" })}
          {field("business.yearsInBusiness", "Years in Business", business.yearsInBusiness, v => onBusinessChange({ ...business, yearsInBusiness: v }), { placeholder: "5" })}
        </div>
      </div>

      <div className={styles.panel}>
        <h2 className={styles.sectionTitle}>Owner Contact</h2>
        <div className={styles.grid2}>
          {field("ownerContact.firstName", "First Name", ownerContact.firstName, v => onOwnerChange({ ...ownerContact, firstName: v }))}
          {field("ownerContact.lastName", "Last Name", ownerContact.lastName, v => onOwnerChange({ ...ownerContact, lastName: v }))}
        </div>
        <div className={`${styles.grid2} ${styles.row}`}>
          {field("ownerContact.title", "Title", ownerContact.title, v => onOwnerChange({ ...ownerContact, title: v }), { placeholder: "Owner" })}
          {field("ownerContact.email", "Email", ownerContact.email, v => onOwnerChange({ ...ownerContact, email: v }), { placeholder: "owner@business.com", type: "email" })}
        </div>
        <div className={styles.row}>
          {field("ownerContact.phone", "Phone", ownerContact.phone, v => onOwnerChange({ ...ownerContact, phone: v }), { placeholder: "555-000-0000", type: "tel" })}
        </div>
      </div>

      {showProcessing && (
        <div className={styles.panel}>
          <h2 className={styles.sectionTitle}>Processing Details</h2>
          <div className={styles.grid2}>
            {field("processing.monthlyVolume", "Monthly Volume ($)", processing.monthlyVolume, v => onProcessingChange({ ...processing, monthlyVolume: v }), { placeholder: "100000", type: "number" })}
            {field("processing.avgTicket", "Average Ticket ($)", processing.avgTicket, v => onProcessingChange({ ...processing, avgTicket: v }), { placeholder: "45", type: "number" })}
          </div>
          <div className={`${styles.grid2} ${styles.row}`}>
            {field("processing.cardPresentPct", "Card Present % (0-100)", processing.cardPresentPct, v => onProcessingChange({ ...processing, cardPresentPct: v }), { placeholder: "80", type: "number" })}
            {field("processing.mcc", "MCC Code", processing.mcc, v => onProcessingChange({ ...processing, mcc: v }), { placeholder: "5812" })}
          </div>
          <div className={styles.row}>
            {field("processing.currentProcessor", "Current Processor", processing.currentProcessor, v => onProcessingChange({ ...processing, currentProcessor: v }), { placeholder: "Stripe" })}
          </div>
          <div className={styles.row}>
            <label className={styles.label}>
              Business Description
              {isFromHubspotField(applied, "processing.businessDescription", processing.businessDescription) && (
                <span className={styles.badgeHubspot}>from HubSpot</span>
              )}
            </label>
            <textarea
              value={processing.businessDescription}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onProcessingChange({ ...processing, businessDescription: e.target.value })}
              placeholder="Briefly describe the nature of the business…"
              className={`${styles.input} ${styles.textarea}`}
            />
          </div>
          <div className={`${styles.inlineRow} ${styles.row}`}>
            <div className={styles.field}>
              <label className={styles.label}>Previously Terminated?</label>
              <select
                value={processing.previouslyTerminated}
                onChange={e => onProcessingChange({ ...processing, previouslyTerminated: e.target.value as ProcessingInfo["previouslyTerminated"] })}
                className={styles.input}
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
            <div className={styles.field}>
              <label className={styles.label}>Bankruptcy (Past 5yr)?</label>
              <select
                value={processing.bankruptcy}
                onChange={e => onProcessingChange({ ...processing, bankruptcy: e.target.value as ProcessingInfo["bankruptcy"] })}
                className={styles.input}
              >
                <option value="no">No</option>
                <option value="yes">Yes</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
