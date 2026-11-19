/**
 * Shared "which documents should this work on?" picker.
 *
 * An empty selection means "all indexed documents", which is what both the AI
 * Teacher and the quiz generator do server-side when no ids are sent.
 */
import { Icon } from './Icons.jsx';
import { pluralise } from '../lib/format.js';

export function ScopePicker({ materials, selected, onChange, noun = 'documents', verb = 'Searching' }) {
  const ready = materials.filter((m) => m.status === 'ready');
  if (ready.length === 0) return null;

  const toggle = (id) => {
    onChange(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };

  return (
    <details className="scope">
      <summary className="scope__summary">
        <Icon name="library" size={15} />
        <span>
          {selected.length === 0
            ? `${verb} all ${ready.length} indexed ${noun}`
            : `${verb} ${selected.length} selected ${noun}`}
        </span>
        <Icon name="chevronDown" size={14} className="scope__chevron" />
      </summary>
      <div className="scope__body">
        <label className="scope__option">
          <input type="checkbox" checked={selected.length === 0} onChange={() => onChange([])} />
          <span>All indexed {noun}</span>
          <span className="scope__meta">
            {ready.reduce((sum, m) => sum + (m.passageCount || 0), 0)} passages
          </span>
        </label>
        {ready.map((material) => (
          <label key={material.id} className="scope__option">
            <input type="checkbox" checked={selected.includes(material.id)} onChange={() => toggle(material.id)} />
            <span className="scope__name">{material.name}</span>
            <span className="scope__meta">
              {material.passageCount} passage{pluralise(material.passageCount, '', 's')}
            </span>
          </label>
        ))}
      </div>
    </details>
  );
}

export default ScopePicker;
