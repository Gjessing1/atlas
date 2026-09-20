import { POI_CATEGORIES, type PoiCategoryId } from '@atlas/core';

/** The unchanged text-only POI selector, reusable by the dock and phone sheet. */
export function PoiCategoryDock({
  categories,
  onToggle,
  onShowAll,
  className = '',
}: {
  categories: readonly PoiCategoryId[];
  onToggle: (id: PoiCategoryId) => void;
  onShowAll: () => void;
  className?: string;
}) {
  return (
    <div
      className={`weather-timeline poi-control ${className}`.trim()}
      role="group"
      aria-label="POI categories"
    >
      <strong className="poi-control-title">POIs</strong>
      <div className="poi-category-scroll">
        <div className="weather-timeline-switch">
          <button type="button" aria-pressed={categories.length === 0} onClick={onShowAll}>
            All
          </button>
          {POI_CATEGORIES.map((category) => (
            <button
              key={category.id}
              type="button"
              aria-pressed={categories.includes(category.id)}
              onClick={() => onToggle(category.id)}
            >
              {category.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
