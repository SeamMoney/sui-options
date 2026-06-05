'use client';
import { useState, useEffect, useMemo } from 'react';

type Side = 'buy' | 'sell';
type Kind = 'call' | 'put';

type OrderType = 'Limit' | 'Market' | 'Stop' | 'Stop limit';
type TimeInForce = 'Good for day' | 'Good til canceled' | 'Immediate or cancel' | 'Fill or kill';

export type OrderEntryProps = {
  symbol: string;
  expiration: string;          // "5/15" form (short)
  strike: number;
  kind: Kind;
  bid: number;
  mark: number;
  ask: number;
  initialSide?: Side;
  buyingPower?: number;        // dollars
  onCancel?: () => void;
  onSubmit?: (order: {
    symbol: string;
    expiration: string;
    strike: number;
    kind: Kind;
    side: Side;
    orderType: OrderType;
    quantity: number;
    limitPrice: number;
    timeInForce: TimeInForce;
  }) => void;
};

const cellBase: React.CSSProperties = {
  fontFamily: 'var(--bw-ds--font-family, system-ui)',
  fontSize: '0.875rem',
  fontWeight: 400,
  letterSpacing: '-0.00625rem',
  lineHeight: 1.3,
  fontFeatureSettings: '"tnum"',
  color: 'var(--colors-neutral-fg1, #fff)',
};

const labelStyle: React.CSSProperties = {
  ...cellBase,
  fontWeight: 600,
};

const subLabelStyle: React.CSSProperties = {
  ...cellBase,
  fontSize: '0.75rem',
  color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
  marginTop: 2,
};

const fmt$ = (v: number) =>
  v.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

const fmt$2 = (v: number) =>
  '$' + (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(2));

const SegmentedToggle: React.FC<{
  options: { value: Side; label: string }[];
  value: Side;
  onChange: (v: Side) => void;
}> = ({ options, value, onChange }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gap: 6,
      background: 'var(--colors-neutral-bg2, rgba(255,255,255,.08))',
      borderRadius: 6,
      padding: 4,
    }}
  >
    {options.map((o) => {
      const active = o.value === value;
      const buy = o.value === 'buy';
      const activeBg = buy ? 'var(--colors-extended-prime, #00c805)' : 'var(--colors-extended-joule, #ff5000)';
      return (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={{
            ...cellBase,
            fontWeight: 700,
            border: 0,
            borderRadius: 4,
            padding: '10px 12px',
            cursor: 'pointer',
            background: active ? activeBg : 'transparent',
            color: active ? '#000' : 'var(--colors-neutral-fg1, #fff)',
            transition: 'background-color 100ms cubic-bezier(.05,.39,.42,.94)',
          }}
        >
          {o.label}
        </button>
      );
    })}
  </div>
);

const Field: React.FC<{
  label: string;
  sublabel?: React.ReactNode;
  children: React.ReactNode;
}> = ({ label, sublabel, children }) => (
  <div
    style={{
      display: 'grid',
      gridTemplateColumns: '1fr auto',
      gap: 12,
      alignItems: 'start',
      padding: '12px 0',
    }}
  >
    <div>
      <div style={labelStyle}>{label}</div>
      {sublabel && <div style={subLabelStyle}>{sublabel}</div>}
    </div>
    <div>{children}</div>
  </div>
);

const Dropdown: React.FC<{ value: string; options: string[]; onChange: (v: string) => void; width?: number }> = ({
  value,
  options,
  onChange,
  width = 160,
}) => {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          ...cellBase,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          inlineSize: width,
          padding: '10px 12px',
          background: 'var(--colors-neutral-bg2, rgba(255,255,255,.08))',
          border: 0,
          borderRadius: 6,
          color: 'var(--colors-neutral-fg1, #fff)',
          cursor: 'pointer',
          fontWeight: 500,
        }}
      >
        <span>{value}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M5 6l3-3 3 3M5 10l3 3 3-3" stroke="currentColor" fill="none" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            insetInlineEnd: 0,
            zIndex: 30,
            background: 'var(--colors-neutral-bg1, #0a0a0a)',
            border: '1px solid var(--colors-neutral-bg3, rgba(255,255,255,.16))',
            borderRadius: 6,
            padding: 4,
            boxShadow: '0 8px 24px rgba(0,0,0,.5)',
            minWidth: width,
          }}
        >
          {options.map((opt) => (
            <button
              key={opt}
              type="button"
              onClick={() => { onChange(opt); setOpen(false); }}
              style={{
                ...cellBase,
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 10px',
                border: 0,
                borderRadius: 4,
                background: opt === value ? 'var(--colors-neutral-bg2, rgba(255,255,255,.08))' : 'transparent',
                color: 'var(--colors-neutral-fg1, #fff)',
                cursor: 'pointer',
              }}
              onPointerEnter={(e) => {
                if (opt !== value) (e.currentTarget as HTMLElement).style.background = 'var(--colors-neutral-bg2, rgba(255,255,255,.08))';
              }}
              onPointerLeave={(e) => {
                if (opt !== value) (e.currentTarget as HTMLElement).style.background = 'transparent';
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const NumberStepper: React.FC<{
  value: number;
  step?: number;
  min?: number;
  max?: number;
  decimals?: number;
  prefix?: string;
  warning?: boolean;
  inlineWidth?: number;
  onChange: (v: number) => void;
}> = ({ value, step = 1, min = 0, max, decimals = 0, prefix = '', warning = false, inlineWidth = 160, onChange }) => {
  const display = useMemo(() => {
    const v = decimals > 0 ? value.toFixed(decimals) : String(value);
    return prefix + v;
  }, [value, decimals, prefix]);
  const setRaw = (raw: string) => {
    const num = parseFloat(raw.replace(/[^\d.-]/g, ''));
    if (Number.isFinite(num)) {
      let n = num;
      if (max !== undefined) n = Math.min(max, n);
      n = Math.max(min, n);
      onChange(+n.toFixed(decimals));
    }
  };
  const tick = (dir: 1 | -1) => {
    let n = value + dir * step;
    n = Math.max(min, n);
    if (max !== undefined) n = Math.min(max, n);
    onChange(+n.toFixed(decimals));
  };
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        background: 'var(--colors-neutral-bg2, rgba(255,255,255,.08))',
        border: `1px solid ${warning ? 'var(--colors-accent-negative, #ff5000)' : 'var(--colors-neutral-fg1, #fff)'}`,
        borderRadius: 6,
        inlineSize: inlineWidth,
        overflow: 'hidden',
      }}
    >
      <input
        type="text"
        value={display}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={(e) => setRaw(e.target.value)}
        style={{
          ...cellBase,
          flex: 1,
          minInlineSize: 0,
          background: 'transparent',
          border: 0,
          outline: 'none',
          padding: '10px 10px',
          color: 'var(--colors-neutral-fg1, #fff)',
          textAlign: 'start',
          fontWeight: 500,
        }}
      />
      <div style={{ display: 'flex', flexDirection: 'column', borderInlineStart: '1px solid var(--colors-neutral-bg3, rgba(255,255,255,.16))' }}>
        <button type="button" aria-label="Increment" onClick={() => tick(1)} style={stepperBtnStyle('top')}>
          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11l5-5 5 5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
        </button>
        <button type="button" aria-label="Decrement" onClick={() => tick(-1)} style={stepperBtnStyle('bottom')}>
          <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 5l5 5 5-5" stroke="currentColor" strokeWidth="1.8" fill="none" strokeLinecap="round" /></svg>
        </button>
      </div>
    </div>
  );
};

const stepperBtnStyle = (which: 'top' | 'bottom'): React.CSSProperties => ({
  inlineSize: 28,
  blockSize: 21,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'transparent',
  border: 0,
  borderBlockEnd: which === 'top' ? '1px solid var(--colors-neutral-bg3, rgba(255,255,255,.16))' : 0,
  color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))',
  cursor: 'pointer',
});

export function OrderEntryFlyout({
  symbol,
  expiration,
  strike,
  kind,
  bid,
  mark,
  ask,
  initialSide = 'buy',
  buyingPower = 2.0,
  onCancel,
  onSubmit,
}: OrderEntryProps) {
  const [side, setSide] = useState<Side>(initialSide);
  const [orderType, setOrderType] = useState<OrderType>('Limit');
  const [quantity, setQuantity] = useState<number>(1);
  const [limitPrice, setLimitPrice] = useState<number>(side === 'buy' ? ask : bid);
  const [tif, setTif] = useState<TimeInForce>('Good for day');

  // When side flips, snap limit price to that side's quote
  useEffect(() => {
    setLimitPrice(side === 'buy' ? ask : bid);
  }, [side, ask, bid]);

  const contractValue = limitPrice * 100 * quantity; // 1 contract = 100 shares
  const fees = 0.04 * quantity; // est regulatory fee per contract
  const estimatedCost = side === 'buy' ? contractValue + 2 + fees : 0;
  const estimatedCredit = side === 'sell' ? contractValue - 2 - fees : 0;
  const collateralRequired = side === 'sell' ? strike * 100 * quantity : 0;
  const exceedsBuyingPower = side === 'buy' ? estimatedCost > buyingPower : collateralRequired > buyingPower;
  const orderTypeLabel = kind === 'call' ? 'Call' : 'Put';

  return (
    <section
      role="dialog"
      aria-label={`Order entry for ${symbol} ${expiration} $${strike} ${orderTypeLabel}`}
      style={{
        background: 'transparent',
        color: 'var(--colors-neutral-fg1, #fff)',
        inlineSize: '100%',
        blockSize: '100%',
        fontFamily: 'var(--bw-ds--font-family, system-ui)',
        overflow: 'auto',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px 6px' }}>
        <span aria-hidden="true" style={{ inlineSize: 18, color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))', cursor: 'grab', marginInlineEnd: 8 }}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="5" cy="5" r="1.2" fill="currentColor" />
            <circle cx="5" cy="11" r="1.2" fill="currentColor" />
            <circle cx="11" cy="5" r="1.2" fill="currentColor" />
            <circle cx="11" cy="11" r="1.2" fill="currentColor" />
          </svg>
        </span>
        <button type="button" onClick={onCancel} aria-label="Close" style={{
          marginInlineStart: 'auto',
          inlineSize: 28, blockSize: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 0, borderRadius: 4,
          color: 'var(--colors-neutral-fg2, rgba(255,255,255,.65))', cursor: 'pointer',
        }}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {/* Contract title */}
      <div style={{ padding: '0 16px 14px' }}>
        <div style={{ ...cellBase, fontSize: '1.125rem', fontWeight: 700 }}>
          {symbol} {expiration} ${strike} {orderTypeLabel}
        </div>
      </div>

      {/* Side toggle */}
      <div style={{ padding: '0 16px 14px' }}>
        <SegmentedToggle
          options={[{ value: 'buy', label: 'Buy to open' }, { value: 'sell', label: 'Sell to open' }]}
          value={side}
          onChange={setSide}
        />
      </div>

      <div style={{ padding: '0 16px' }}>
        {/* Order type */}
        <Field label="Order type">
          <Dropdown
            value={orderType}
            options={['Limit', 'Market', 'Stop', 'Stop limit']}
            onChange={(v) => setOrderType(v as OrderType)}
          />
        </Field>

        {/* Quantity */}
        <Field label="Quantity">
          <NumberStepper
            value={quantity}
            step={1}
            min={1}
            onChange={setQuantity}
            warning={exceedsBuyingPower}
          />
        </Field>
        {exceedsBuyingPower && (
          <div style={{
            ...cellBase,
            fontSize: '0.8125rem',
            color: 'var(--colors-accent-negative, #ff5000)',
            paddingBlockEnd: 8,
          }}>
            You don&apos;t have enough buying power to {side === 'buy' ? 'place this order' : "cover this order's collateral"}.{' '}
            <a href="#" onClick={(e) => e.preventDefault()} style={{ color: 'inherit', fontWeight: 700, textDecoration: 'underline' }}>Deposit funds</a>
          </div>
        )}

        {/* Limit price */}
        <Field
          label="Limit price"
          sublabel={
            side === 'buy'
              ? <>Mark {fmt$2(mark)} • Ask {fmt$2(ask)}</>
              : <>Bid {fmt$2(bid)} • Mark {fmt$2(mark)}</>
          }
        >
          <NumberStepper
            value={limitPrice}
            step={0.05}
            min={0.01}
            decimals={2}
            prefix="$"
            onChange={setLimitPrice}
          />
        </Field>

        {/* Time in force */}
        <Field label="Time in force">
          <Dropdown
            value={tif}
            options={['Good for day', 'Good til canceled', 'Immediate or cancel', 'Fill or kill']}
            onChange={(v) => setTif(v as TimeInForce)}
          />
        </Field>
      </div>

      {/* Estimated cost / credit / collateral */}
      <div style={{ padding: '12px 16px 0', borderBlockStart: '1px solid var(--colors-neutral-bg2, rgba(255,255,255,.08))' }}>
        {side === 'sell' && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0' }}>
            <div style={labelStyle}>Collateral required</div>
            <div style={{ ...labelStyle, fontWeight: 700 }}>{fmt$(collateralRequired)}</div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '6px 0' }}>
          <div>
            <div style={labelStyle}>{side === 'buy' ? 'Estimated cost' : 'Estimated credit'}</div>
            <div style={subLabelStyle}>{fmt$(buyingPower)} buying power</div>
            <div style={subLabelStyle}>{fmt$(fees)} est regulatory fee</div>
          </div>
          <div style={{ ...labelStyle, fontWeight: 700, fontSize: '1rem' }}>
            {fmt$(side === 'buy' ? estimatedCost : estimatedCredit)}
          </div>
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '14px 16px' }}>
        <button
          type="button"
          onClick={onCancel}
          style={{
            ...cellBase,
            fontWeight: 700,
            border: 0,
            borderRadius: 6,
            padding: '12px 14px',
            background: 'var(--colors-neutral-bg2, rgba(255,255,255,.08))',
            color: 'var(--colors-neutral-fg1, #fff)',
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={exceedsBuyingPower}
          onClick={() => {
            if (exceedsBuyingPower) return;
            onSubmit?.({ symbol, expiration, strike, kind, side, orderType, quantity, limitPrice, timeInForce: tif });
          }}
          style={{
            ...cellBase,
            fontWeight: 700,
            border: 0,
            borderRadius: 6,
            padding: '12px 14px',
            background: exceedsBuyingPower
              ? 'var(--colors-neutral-bg2, rgba(255,255,255,.08))'
              : (side === 'buy' ? 'var(--colors-extended-prime, #00c805)' : 'var(--colors-extended-joule, #ff5000)'),
            color: exceedsBuyingPower ? 'var(--colors-neutral-fg2, rgba(255,255,255,.65))' : '#000',
            cursor: exceedsBuyingPower ? 'not-allowed' : 'pointer',
            opacity: exceedsBuyingPower ? 0.7 : 1,
          }}
        >
          {side === 'buy' ? 'Buy' : 'Sell'} {symbol} {orderTypeLabel}
        </button>
      </div>
    </section>
  );
}
