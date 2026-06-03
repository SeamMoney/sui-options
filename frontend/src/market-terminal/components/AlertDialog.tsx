import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Bell } from 'lucide-react';
import CustomSelect, { type CustomSelectOption } from './CustomSelect';
import type { ActiveIndicator } from '../chart/types';
import { indicatorRegistry } from '../chart/indicators/registry';
import type { ChartAlert, PriceAlert, PriceCondition, IndicatorCondition } from '../lib/alerts';

interface AlertDialogProps {
  open: boolean;
  symbol: string;
  initialPrice: number;
  activeIndicators: ActiveIndicator[];
  editAlert?: PriceAlert;
  onClose: () => void;
  onSave: (alert: ChartAlert) => void;
}

const PRICE_CONDITIONS: CustomSelectOption[] = [
  { value: 'crosses_above', label: 'Crosses Above' },
  { value: 'crosses_below', label: 'Crosses Below' },
];

const INDICATOR_CONDITIONS: CustomSelectOption[] = [
  { value: 'crosses_above', label: 'Crosses Above' },
  { value: 'crosses_below', label: 'Crosses Below' },
  { value: 'rises_above', label: 'Rises Above' },
  { value: 'falls_below', label: 'Falls Below' },
];

export default function AlertDialog({ open, symbol, initialPrice, activeIndicators, editAlert, onClose, onSave }: AlertDialogProps) {
  const [tab, setTab] = useState<'price' | 'indicator'>('price');
  const [label, setLabel] = useState('');
  const [priceCondition, setPriceCondition] = useState<PriceCondition>('crosses_above');
  const [priceValue, setPriceValue] = useState(initialPrice);
  const [indicatorId, setIndicatorId] = useState('');
  const [outputKey, setOutputKey] = useState('');
  const [indicatorCondition, setIndicatorCondition] = useState<IndicatorCondition>('crosses_above');
  const [indicatorTarget, setIndicatorTarget] = useState('');

  // Sync price when dialog opens with a new prefill or edit data
  useEffect(() => {
    if (open) {
      if (editAlert) {
        setTab('price');
        setPriceCondition(editAlert.condition);
        setPriceValue(editAlert.price);
        setLabel(editAlert.label ?? '');
      } else {
        setPriceValue(initialPrice);
      }
    }
  }, [open, initialPrice, editAlert]);

  // Reset indicator selection when switching to indicator tab or when active indicators change
  useEffect(() => {
    if (activeIndicators.length > 0 && !indicatorId) {
      const first = activeIndicators[0];
      setIndicatorId(first.id);
      const meta = indicatorRegistry[first.name];
      setOutputKey(meta?.outputs[0]?.key ?? '');
    }
  }, [activeIndicators, indicatorId]);

  const handleClose = useCallback(() => {
    setLabel('');
    setTab('price');
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  function handleSave() {
    const id = editAlert?.id ?? crypto.randomUUID();
    const createdAt = editAlert?.createdAt ?? Date.now();
    if (tab === 'price') {
      const price = parseFloat(String(priceValue));
      if (!isFinite(price)) return;
      onSave({
        id,
        type: 'price',
        symbol,
        label: label.trim() || undefined,
        condition: priceCondition,
        price,
        status: 'active',
        createdAt,
      });
    } else {
      const ind = activeIndicators.find(i => i.id === indicatorId);
      if (!ind) return;
      const target = parseFloat(indicatorTarget);
      if (!isFinite(target)) return;
      onSave({
        id,
        type: 'indicator',
        symbol,
        label: label.trim() || undefined,
        indicatorId: ind.id,
        indicatorName: ind.name,
        outputKey,
        condition: indicatorCondition,
        targetValue: target,
        status: 'active',
        createdAt: Date.now(),
      });
    }
    handleClose();
  }

  // Build indicator options from active indicators
  const indicatorOptions: CustomSelectOption[] = activeIndicators.map(ind => ({
    value: ind.id,
    label: ind.name,
  }));

  // Build output options for selected indicator
  const selectedInd = activeIndicators.find(i => i.id === indicatorId);
  const outputOptions: CustomSelectOption[] = selectedInd
    ? (indicatorRegistry[selectedInd.name]?.outputs ?? []).map(o => ({ value: o.key, label: o.label }))
    : [];

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[220] flex items-center justify-center bg-[#020409]/60 backdrop-blur-[4px]"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="w-[min(90vw,400px)] rounded-lg border border-white/[0.1] bg-[#161B22] shadow-2xl shadow-black/60">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/[0.07] px-4 py-3">
          <div className="flex items-center gap-2">
            <Bell size={14} className="text-amber-400" />
            <span className="font-mono text-[12px] text-white/90">{editAlert ? 'Edit Alert' : 'Add Alert'}</span>
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/50">{symbol}</span>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="flex h-6 w-6 items-center justify-center rounded text-white/40 transition-colors hover:bg-white/[0.06] hover:text-white/70"
          >
            <X size={13} />
          </button>
        </div>

        {/* Tab switcher — hidden when editing a price alert */}
        {!editAlert && (
          <div className="flex border-b border-white/[0.07]">
            {(['price', 'indicator'] as const).map(t => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`flex-1 py-2 font-mono text-[10px] uppercase tracking-[0.12em] transition-colors ${tab === t ? 'border-b-2 border-amber-400 text-amber-400' : 'text-white/40 hover:text-white/60'}`}
              >
                {t === 'price' ? 'Price' : 'Indicator'}
              </button>
            ))}
          </div>
        )}

        {/* Body */}
        <div className="flex flex-col gap-3 p-4">
          {tab === 'price' ? (
            <>
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Condition</label>
                <CustomSelect
                  value={priceCondition}
                  onChange={v => setPriceCondition(v as PriceCondition)}
                  options={PRICE_CONDITIONS}
                  size="sm"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Price</label>
                <input
                  type="number"
                  step="0.01"
                  value={priceValue}
                  onChange={e => setPriceValue(parseFloat(e.target.value) || 0)}
                  className="h-9 w-full rounded-sm border border-white/[0.08] bg-[#0D1117] px-3 font-mono text-[11px] text-white/90 outline-none focus:border-white/[0.2]"
                />
              </div>
            </>
          ) : (
            <>
              {activeIndicators.length === 0 ? (
                <p className="py-4 text-center font-mono text-[10px] text-white/35">No indicators active on this chart</p>
              ) : (
                <>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Indicator</label>
                    <CustomSelect
                      value={indicatorId}
                      onChange={v => {
                        setIndicatorId(v);
                        const ind = activeIndicators.find(i => i.id === v);
                        const meta = indicatorRegistry[ind?.name ?? ''];
                        setOutputKey(meta?.outputs[0]?.key ?? '');
                      }}
                      options={indicatorOptions}
                      size="sm"
                    />
                  </div>
                  {outputOptions.length > 1 && (
                    <div className="flex flex-col gap-1.5">
                      <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Line</label>
                      <CustomSelect
                        value={outputKey}
                        onChange={setOutputKey}
                        options={outputOptions}
                        size="sm"
                      />
                    </div>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Condition</label>
                    <CustomSelect
                      value={indicatorCondition}
                      onChange={v => setIndicatorCondition(v as IndicatorCondition)}
                      options={INDICATOR_CONDITIONS}
                      size="sm"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Value</label>
                    <input
                      type="number"
                      step="0.01"
                      value={indicatorTarget}
                      onChange={e => setIndicatorTarget(e.target.value)}
                      placeholder="e.g. 70"
                      className="h-9 w-full rounded-sm border border-white/[0.08] bg-[#0D1117] px-3 font-mono text-[11px] text-white/90 outline-none placeholder:text-white/20 focus:border-white/[0.2]"
                    />
                  </div>
                </>
              )}
            </>
          )}

          {/* Optional label */}
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] uppercase tracking-[0.1em] text-white/40">Label <span className="text-white/20">(optional)</span></label>
            <input
              type="text"
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="e.g. Support level"
              className="h-9 w-full rounded-sm border border-white/[0.08] bg-[#0D1117] px-3 font-mono text-[11px] text-white/90 outline-none placeholder:text-white/20 focus:border-white/[0.2]"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-white/[0.07] px-4 py-3">
          <button
            type="button"
            onClick={handleClose}
            className="h-8 rounded px-3 font-mono text-[10px] text-white/40 transition-colors hover:text-white/60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={tab === 'indicator' && activeIndicators.length === 0}
            className="h-8 rounded bg-amber-500/15 px-4 font-mono text-[10px] text-amber-400 transition-colors hover:bg-amber-500/25 disabled:cursor-not-allowed disabled:opacity-35"
          >
            {editAlert ? 'Save Changes' : 'Create Alert'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
