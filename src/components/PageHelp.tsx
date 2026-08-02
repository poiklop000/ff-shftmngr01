import { useState } from 'react';
import { ChevronDown, HelpCircle } from 'lucide-react';

export interface HelpSection {
  title: string;
  items: string[];
}

interface PageHelpProps {
  title: string;
  intro: string;
  sections: HelpSection[];
}

export function PageHelp({ intro, sections }: PageHelpProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="page-help no-print">
      <button
        type="button"
        className="page-help-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <HelpCircle size={16} />
        <span>How to use this page</span>
        <ChevronDown
          size={16}
          className={`page-help-chevron ${open ? 'page-help-chevron-open' : ''}`}
        />
      </button>

      {open && (
        <div className="page-help-body">
          <p className="page-help-intro">{intro}</p>
          {sections.map((section) => (
            <div key={section.title} className="page-help-section">
              <h4 className="page-help-section-title">{section.title}</h4>
              <ul className="page-help-list">
                {section.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
