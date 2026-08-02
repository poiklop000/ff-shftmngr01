import { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatNumberField,
  parseNumber,
  type CalcInputs,
} from '@/types';
import { useAutoSelect, useEnterToNext } from '@/lib/ui';
import { PageHelp } from '@/components/PageHelp';

interface CalculatorViewProps {
  calc: CalcInputs;
  onChange: (field: keyof CalcInputs, value: string) => void;
  onUpdate: () => void;
  onClear: () => void;
}

const FIELD_ORDER: (keyof CalcInputs)[] = [
  'product', 'size', 'plan', 'speed', 'uvol', 'mvol', 'ratio',
  'counter', 'bowl', 'layer', 'pallet',
];

const FIELD_IDS: Record<keyof CalcInputs, string> = {
  product: 'tx-product', size: 'dr-size', plan: 'tx-plan', speed: 'tx-speed',
  uvol: 'tx-uvol', mvol: 'tx-mvol', ratio: 'tx-ratio', counter: 'tx-counter',
  bowl: 'tx-bowl', layer: 'tx-layer', pallet: 'tx-pallet',
};

export function CalculatorView({ calc, onChange, onUpdate, onClear }: CalculatorViewProps) {
  const [clockTick, setClockTick] = useState(0);

  const metrics = useMemo(() => {
    void clockTick;
    const sz = parseNumber(calc.size);
    const pl = parseNumber(calc.plan);
    const sp = parseNumber(calc.speed);
    const uv = parseNumber(calc.uvol);
    const mv = parseNumber(calc.mvol);
    const rt = parseNumber(calc.ratio);
    const cnt = parseNumber(calc.counter);
    const fb = parseNumber(calc.bowl);
    const cl = parseNumber(calc.layer);
    const lp = parseNumber(calc.pallet);

    if (sz > 0 && pl > 0) {
      const rem = ((uv + 110.0) / (rt / 100.0 > 0 ? rt / 100.0 : 0.10) + mv + fb) / sz;
      const finalCount = Math.round(cnt + rem);
      const yPct = (finalCount / pl) * 100;
      const dp = Math.max(0, rem / cl - 7);
      const palletsLeft = lp > 0 ? dp / lp : 0;

      let finishTime = '00:00:00';
      if (rem > 0 && sp > 0) {
        const totalSec = (rem / sp) * 3600;
        const finish = new Date(Date.now() + totalSec * 1000);
        const pad = (n: number) => String(n).padStart(2, '0');
        finishTime = `${pad(finish.getHours())}:${pad(finish.getMinutes())}:${pad(finish.getSeconds())}`;
      }

      return {
        remaining: Math.round(rem).toLocaleString(),
        finalCount: finalCount.toLocaleString(),
        yieldPct: yPct,
        depal: dp.toFixed(1),
        palletsLeft: palletsLeft.toFixed(1),
        finishTime,
        hasData: true,
      };
    }
    return {
      remaining: '0', finalCount: '0', yieldPct: 0,
      depal: '0.0', palletsLeft: '0.0', finishTime: '00:00:00', hasData: false,
    };
  }, [calc, clockTick]);

  const yieldClass = metrics.hasData
    ? metrics.yieldPct >= 97 ? 'yield-green' : 'yield-red'
    : 'yield-red';

  return (
    <div className="sm-container">
      <PageHelp
        title="Filler Calculator"
        intro="Estimate your running yield, final can count, and finish time based on remaining syrup and filler speed. Fill in the production details below and press Update to calculate."
        sections={[
          {
            title: "Filling in the inputs",
            items: [
              "Product - type the product name for the current run.",
              "Can Size - pick the package size for this product.",
              "Total Plan - the total quantity you plan to produce this run.",
              "Filler Speed - the rated speed of the filler in cans per hour.",
              "Upstream Volume, Mixer Volume, Mixing Ratio, Filler Bowl Level - enter the remaining syrup and mixing details. These determine how many cans can still be produced.",
              "Filler Production Counter - the current cumulative counter reading from the filler.",
              "Cans per layer and Layers per pallet - used to estimate remaining pallets and depal layers.",
            ],
          },
          {
            title: "Reading the results",
            items: [
              "Production Summary card shows your running yield percentage (green if 97% or above, red if below), estimated final count, and estimated finish time.",
              "End Production card shows how many cans are still left to produce based on remaining syrup, plus how many pallets and depal layers that translates to.",
            ],
          },
          {
            title: "Buttons",
            items: [
              "Update - recalculates all results using the current inputs.",
              "Clear Calculator - wipes every input so you can start fresh. You'll be asked to confirm first.",
              "Press Enter on your keyboard to jump to the next field without clicking.",
            ],
          },
        ]}
      />

      <div className="card card-green">
        <h3>Production Summary</h3>
        <Row label="Product:" value={calc.product.trim() || '-'} />
        <Row label="Running Yield:" value={`${metrics.yieldPct.toFixed(2)}%`} valueClass={yieldClass} />
        <Row label="Estimated Final Count:" value={metrics.finalCount} />
        <Row label="Estimated Finish Time:" value={metrics.finishTime} />
      </div>

      <div className="section-panel">
        <CalcField label="Product" field="product" calc={calc} onChange={onChange} type="text" placeholder="Enter product name..." />
        <SelectField label="Can Size" field="size" calc={calc} onChange={onChange} />
        <CalcField label="Total Plan" field="plan" calc={calc} onChange={onChange} type="text" inputMode="numeric" placeholder="0" formatOnBlur />
        <CalcField label="Filler Speed" field="speed" calc={calc} onChange={onChange} type="text" inputMode="decimal" placeholder="0" formatOnBlur />
      </div>

      <div className="section-panel">
        <CalcField label="Upstream Volume (Final Syrup)" field="uvol" calc={calc} onChange={onChange} type="text" inputMode="decimal" placeholder="0" formatOnBlur />
        <CalcField label="Mixer Volume (ContiFlow KB)" field="mvol" calc={calc} onChange={onChange} type="number" inputMode="decimal" placeholder="0" />
        <CalcField label="Mixing Ratio %" field="ratio" calc={calc} onChange={onChange} type="number" inputMode="decimal" placeholder="0" />
        <CalcField label="Filler Production Counter" field="counter" calc={calc} onChange={onChange} type="text" inputMode="numeric" placeholder="0" formatOnBlur />
        <CalcField label="Filler bowl level" field="bowl" calc={calc} onChange={onChange} type="number" inputMode="decimal" placeholder="0" />
        <CalcField label="Cans per layer" field="layer" calc={calc} onChange={onChange} type="number" inputMode="numeric" placeholder="0" />
        <CalcField label="Layers per pallet" field="pallet" calc={calc} onChange={onChange} type="number" inputMode="numeric" placeholder="0" />
        <div className="sm-btn-row">
          <button
            type="button"
            className="tab-btn tab-btn-blue"
            onClick={() => {
              setClockTick((t) => t + 1);
              onUpdate();
            }}
          >
            Update
          </button>
        </div>
        <div className="sm-btn-row">
          <button type="button" className="tab-btn tab-btn-red" onClick={onClear}>Clear Calculator</button>
        </div>
      </div>

      <div className="card card-teal">
        <h3>End Production (Based on remaining Syrup left)</h3>
        <Row label="Remaining cans to be produce:" value={metrics.remaining} />
        <Row label="Estimated pallets left:" value={metrics.palletsLeft} />
        <Row label="Estimated layers left (-7):" value={metrics.depal} />
      </div>
    </div>
  );
}

function Row({ label, value, valueClass = '' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="card-row">
      <span>{label}</span>
      <span className={`card-value ${valueClass}`}>{value}</span>
    </div>
  );
}

interface CalcFieldProps {
  label: string;
  field: keyof CalcInputs;
  calc: CalcInputs;
  onChange: (field: keyof CalcInputs, value: string) => void;
  type: 'text' | 'number';
  inputMode?: 'numeric' | 'decimal';
  placeholder?: string;
  formatOnBlur?: boolean;
}

function CalcField({ label, field, calc, onChange, type, inputMode, placeholder, formatOnBlur }: CalcFieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  const id = FIELD_IDS[field];
  const idx = FIELD_ORDER.indexOf(field);
  const nextId = idx < FIELD_ORDER.length - 1 ? FIELD_IDS[FIELD_ORDER[idx + 1]] : FIELD_IDS.product;

  useAutoSelect(ref, [field]);
  useEnterToNext(ref, nextId, [field]);

  return (
    <div className="input-group">
      <label htmlFor={id}>{label}</label>
      <input
        ref={ref}
        id={id}
        type={type}
        inputMode={inputMode}
        className="form-control"
        placeholder={placeholder}
        value={calc[field]}
        onChange={(e) => onChange(field, e.target.value)}
        onBlur={formatOnBlur ? (e) => onChange(field, formatNumberField(e.target.value)) : undefined}
      />
    </div>
  );
}

function SelectField({ label, field, calc, onChange }: {
  label: string;
  field: keyof CalcInputs;
  calc: CalcInputs;
  onChange: (field: keyof CalcInputs, value: string) => void;
}) {
  const ref = useRef<HTMLSelectElement>(null);
  const id = FIELD_IDS[field];
  const idx = FIELD_ORDER.indexOf(field);
  const nextId = idx < FIELD_ORDER.length - 1 ? FIELD_IDS[FIELD_ORDER[idx + 1]] : FIELD_IDS.product;

  useEffectEnterToNextSelect(ref, nextId);

  return (
    <div className="input-group">
      <label htmlFor={id}>{label}</label>
      <select
        ref={ref}
        id={id}
        className="form-control"
        value={calc[field]}
        onChange={(e) => onChange(field, e.target.value)}
      >
        <option value="">Select package size...</option>
        <option value="0.250">0.250</option>
        <option value="0.330">0.330</option>
        <option value="0.355">0.355</option>
        <option value="0.440">0.440</option>
        <option value="0.500">0.500</option>
      </select>
    </div>
  );
}

function useEffectEnterToNextSelect(ref: React.RefObject<HTMLSelectElement>, nextId: string) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      const ke = e as KeyboardEvent;
      if (ke.key === 'Enter') {
        ke.preventDefault();
        const next = document.getElementById(nextId);
        if (next) (next as HTMLElement).focus();
      }
    };
    el.addEventListener('keydown', handler as EventListener);
    return () => el.removeEventListener('keydown', handler as EventListener);
  }, [ref, nextId]);
}
