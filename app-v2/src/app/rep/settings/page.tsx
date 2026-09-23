"use client";

import { useState, useEffect } from "react";
import { getSettingsAction, saveSettingsAction } from "@/lib/actions/applications";
import { DEFAULT_PROCESSOR } from "@/lib/defaults";
import type { AppSettings, Processor, ProcessorTier } from "@/types/merchant";
import styles from "./settings.module.css";

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>({
    processors: [DEFAULT_PROCESSOR],
    adyenConfig: { corsProxy: "https://corsproxy.io/?", environment: "test", lemApiKey: "", managementApiKey: "", balancePlatformApiKey: "", companyId: "" },
  });
  const [saved, setSaved]         = useState(false);
  const [loading, setLoading]     = useState(true);
  const [activeProc, setActiveProc] = useState(0);
  const [activeTier, setActiveTier] = useState(0);

  useEffect(() => {
    getSettingsAction().then(s => {
      if (s) setSettings(s);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const save = async () => {
    await saveSettingsAction(settings);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  const setAdyen  = (k: string, v: string) => setSettings(s => ({ ...s, adyenConfig: { ...s.adyenConfig!, [k]: v } }));
  const setTier   = (pk: number, tk: number, k: keyof ProcessorTier, v: string | number | boolean) =>
    setSettings(s => {
      const procs = [...(s.processors || [])];
      const tiers = [...(procs[pk].tiers || [])];
      tiers[tk] = { ...tiers[tk], [k]: v };
      procs[pk] = { ...procs[pk], tiers };
      return { ...s, processors: procs };
    });
  const setProc = (pk: number, k: keyof Processor, v: string | boolean) =>
    setSettings(s => {
      const procs = [...(s.processors || [])];
      procs[pk] = { ...procs[pk], [k]: v };
      return { ...s, processors: procs };
    });

  const addProc = () => {
    const id = `proc_${Date.now()}`;
    setSettings(s => ({
      ...s,
      processors: [...(s.processors || []), { id, name: "New Processor", isDefault: false, tiers: [{ id: `${id}_t1`, name: "Standard", isDefault: true, processingBps: 0.001, perTxnFee: 0.12, schemeBps: 0.0005, monthlyFee: 0 }] }],
    }));
  };
  const addTier = (pk: number) => {
    const id = `tier_${Date.now()}`;
    setSettings(s => {
      const procs = [...(s.processors || [])];
      procs[pk] = { ...procs[pk], tiers: [...(procs[pk].tiers || []), { id, name: "New Tier", isDefault: false, processingBps: 0.001, perTxnFee: 0.12, schemeBps: 0.0005, monthlyFee: 0 }] };
      return { ...s, processors: procs };
    });
  };

  if (loading) return <div className={styles.loading}>Loading settings…</div>;

  const proc = settings.processors?.[activeProc];
  const tier = proc?.tiers?.[activeTier];

  return (
    <div className={styles.main}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.headerTitle}>Settings</h1>
          <p className={styles.headerSubtitle}>Processor rates, Adyen config, and defaults</p>
        </div>
        <button onClick={save} className={styles.btnPrimary} data-saved={saved}>
          {saved ? "✓ Saved" : "Save Settings"}
        </button>
      </div>

      {/* Processors */}
      <div className={styles.panel}>
        <div className={styles.panelHeader}>
          <h2 className={styles.panelTitle}>Processors</h2>
          <button onClick={addProc} className={styles.pillAdd}>+ Add Processor</button>
        </div>

        {/* Processor tabs */}
        <div className={styles.pillRow}>
          {(settings.processors || []).map((p, i) => (
            <button key={p.id} onClick={() => { setActiveProc(i); setActiveTier(0); }} className={styles.pill} data-active={i === activeProc}>
              {p.name} {p.isDefault && <span className={styles.pillBadge}>DEFAULT</span>}
            </button>
          ))}
        </div>

        {proc && (
          <div>
            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label className={styles.label}>Processor Name</label>
                <input value={proc.name} onChange={e => setProc(activeProc, "name", e.target.value)} className={styles.input} />
              </div>
              <div className={styles.checkboxField}>
                <label className={styles.checkboxLabel}>
                  <input type="checkbox" checked={proc.isDefault} onChange={e => setProc(activeProc, "isDefault", e.target.checked)} />
                  <span>Default processor</span>
                </label>
              </div>
            </div>

            {/* Tier tabs */}
            <div className={styles.pillRow}>
              {(proc.tiers || []).map((t, i) => (
                <button key={t.id} onClick={() => setActiveTier(i)} className={styles.pillSecondary} data-active={i === activeTier}>
                  {t.name} {t.isDefault && "✓"}
                </button>
              ))}
              <button onClick={() => addTier(activeProc)} className={styles.pillAdd}>+ Tier</button>
            </div>

            {tier && (
              <div className={styles.tierPanel}>
                <div className={styles.fieldGrid4}>
                  {[
                    { label: "Processing BPS (e.g. 0.0010)", key: "processingBps" as keyof ProcessorTier, val: tier.processingBps },
                    { label: "Scheme BPS (e.g. 0.0005)", key: "schemeBps" as keyof ProcessorTier, val: tier.schemeBps },
                    { label: "Per-Txn Fee ($)", key: "perTxnFee" as keyof ProcessorTier, val: tier.perTxnFee },
                    { label: "Monthly Fee ($)", key: "monthlyFee" as keyof ProcessorTier, val: tier.monthlyFee },
                  ].map(f => (
                    <div key={f.key} className={styles.field}>
                      <label className={styles.label}>{f.label}</label>
                      <input
                        type="number" step="0.0001"
                        value={f.val}
                        onChange={e => setTier(activeProc, activeTier, f.key, parseFloat(e.target.value) || 0)}
                        className={styles.input}
                      />
                    </div>
                  ))}
                </div>
                <div style={{ marginTop: 12 }}>
                  <label className={styles.checkboxLabel}>
                    <input type="checkbox" checked={tier.isDefault} onChange={e => setTier(activeProc, activeTier, "isDefault", e.target.checked)} />
                    <span>Default tier</span>
                  </label>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Adyen config */}
      <div className={styles.panel}>
        <h2 className={styles.panelTitle}>Adyen Config</h2>
        <p className={styles.panelNote}>Phase 2 — Adyen hosted onboarding. API keys should be set as env vars on Vercel, not stored here.</p>
        <div className={styles.fieldGrid2}>
          <div className={styles.field}>
            <label className={styles.label}>CORS Proxy (legacy use only)</label>
            <input value={settings.adyenConfig?.corsProxy || ""} onChange={e => setAdyen("corsProxy", e.target.value)} className={styles.input} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Environment</label>
            <select value={settings.adyenConfig?.environment || "test"} onChange={e => setAdyen("environment", e.target.value)} className={styles.input} style={{ appearance: "auto" }}>
              <option value="test">test</option>
              <option value="live">live</option>
            </select>
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Company ID</label>
            <input value={settings.adyenConfig?.companyId || ""} onChange={e => setAdyen("companyId", e.target.value)} placeholder="YOUR_COMPANY_ID" className={styles.input} />
          </div>
        </div>
        <div className={styles.callout}>
          <p className={styles.calloutText}>
            Vestigial: nothing server-side reads these. EasyOB no longer creates Adyen
            accounts — AIO&apos;s platform does, configured via the <code>AIO_DASHBOARD_*</code> env vars.
          </p>
        </div>
      </div>
    </div>
  );
}
