import type { LatLng, SearchResult } from '@atlas/core';
import { useEffect, useRef, useState } from 'react';

interface SearchBoxProps {
  /** Called when the user picks a result. */
  onSelect: (result: SearchResult) => void;
  /** Current map center, used to bias results towards the viewport. */
  getBias: () => LatLng | null;
}

export function SearchBox({ onSelect, getBias }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  // Picking a result writes its name into the input; that change must not
  // re-trigger a search (which would pop the dropdown right back open).
  const pickedRef = useRef<string | null>(null);

  useEffect(() => {
    abortRef.current?.abort();
    const q = query.trim();
    if (q === pickedRef.current) return;
    pickedRef.current = null;
    if (q.length < 2) {
      setResults([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q });
        const bias = getBias();
        if (bias) {
          params.set('lat', String(bias.lat));
          params.set('lon', String(bias.lng));
        }
        const res = await fetch(`/api/search?${params}`, { signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { results: SearchResult[] };
        setResults(data.results);
        setHighlighted(0);
        setOpen(true);
      } catch {
        // Aborted or offline; keep whatever is shown.
      }
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, getBias]);

  const pick = (result: SearchResult) => {
    pickedRef.current = result.name;
    setQuery(result.name);
    setOpen(false);
    onSelect(result);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open || results.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlighted((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlighted((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      const result = results[highlighted];
      if (result) pick(result);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="searchbox">
      <input
        type="search"
        placeholder="Search places…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => results.length > 0 && setOpen(true)}
        aria-label="Search places"
      />
      {open && results.length > 0 && (
        <ul className="searchbox-results" role="listbox">
          {results.map((result, i) => (
            <li
              key={`${result.position.lat}/${result.position.lng}/${result.name}`}
              role="option"
              aria-selected={i === highlighted}
              className={i === highlighted ? 'highlighted' : undefined}
              onMouseEnter={() => setHighlighted(i)}
              onMouseDown={(e) => {
                e.preventDefault(); // keep input focus
                pick(result);
              }}
            >
              <span className="result-name">{result.name}</span>
              {result.label && <span className="result-label">{result.label}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
