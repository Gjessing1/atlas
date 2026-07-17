import type { LatLng } from '@atlas/core';
import type { SyncState } from '@atlas/app-hooks';

import type { LocalPack } from '../regions/packs';
import type { ImportResult, UserData } from '../useUserData';
import type { DestinationTarget } from './DestinationCard';
import { FavoritesSheet } from './FavoritesSheet';
import { PromptModal } from './PromptModal';
import { SettingsSheet } from './SettingsSheet';
import { TracksSheet } from './TracksSheet';

interface AppSheetsProps {
  data: UserData;
  sync: SyncState;
  packs: LocalPack[];
  onPacksChanged: () => void;
  bottomInset: number;

  favoritesOpen: boolean;
  onCloseFavorites: () => void;
  /** Place whose edit panel the Favorites sheet should open with (map pin → Edit). */
  editPlaceId: string | null;
  tracksOpen: boolean;
  onCloseTracks: () => void;
  settingsOpen: boolean;
  onCloseSettings: () => void;

  /** Coords awaiting a name before they're saved as a pin (name-on-save prompt). */
  pendingPin: LatLng | null;
  onDismissPendingPin: () => void;

  onFlyTo: (p: LatLng) => void;
  /** Open the destination card for a favorite/saved place. */
  onPickDestination: (target: DestinationTarget) => void;
  onImportTracks: () => Promise<ImportResult | null>;
}

/**
 * All modal surfaces above the map: the three ☰ sheets (places & folders,
 * tracks, settings) and the name-this-pin prompt. Pure wiring between the
 * shared user-data/sync hooks and the sheet components — no logic of its own.
 */
export function AppSheets({
  data,
  sync,
  packs,
  onPacksChanged,
  bottomInset,
  favoritesOpen,
  onCloseFavorites,
  editPlaceId,
  tracksOpen,
  onCloseTracks,
  settingsOpen,
  onCloseSettings,
  pendingPin,
  onDismissPendingPin,
  onFlyTo,
  onPickDestination,
  onImportTracks,
}: AppSheetsProps) {
  return (
    <>
      <FavoritesSheet
        visible={favoritesOpen}
        onClose={onCloseFavorites}
        editId={editPlaceId}
        places={data.places}
        collections={data.collections}
        onFlyTo={onFlyTo}
        onNavigate={(p) => {
          onCloseFavorites();
          onPickDestination({ lat: p.lat, lng: p.lng, name: p.name ?? 'Favorite', canSave: false });
        }}
        onPatch={(id, patch) => void data.updatePlace(id, patch)}
        onDelete={(id) => void data.deletePlace(id)}
        onCreateFolder={(name) => void data.createCollection(name)}
        onRenameFolder={(id, name) => void data.renameCollection(id, name)}
        onSetFolderVisible={(id, v) => void data.setCollectionVisible(id, v)}
        onDeleteFolder={(id) => void data.deleteCollection(id)}
        onSetAllVisible={(v) => void data.setAllVisible(v)}
        onReorderPlaces={(ids) => void data.reorderPlaces(ids)}
        onReorderCollections={(ids) => void data.reorderCollections(ids)}
        bottomInset={bottomInset}
      />
      <TracksSheet
        visible={tracksOpen}
        onClose={onCloseTracks}
        tracks={data.tracks}
        onSetVisible={(id, v) => void data.updateTrack(id, { visible: v })}
        onRename={(id, name) => void data.updateTrack(id, { name })}
        onExport={(id, format) => void data.exportTrack(id, format)}
        onDelete={(id) => void data.deleteTrack(id)}
        onImport={onImportTracks}
        bottomInset={bottomInset}
      />
      <SettingsSheet
        visible={settingsOpen}
        onClose={onCloseSettings}
        sync={sync}
        packs={packs}
        onPacksChanged={onPacksChanged}
        storage={data.storage}
        onExportAll={() => void data.exportAll()}
        bottomInset={bottomInset}
      />
      <PromptModal
        visible={pendingPin !== null}
        title="Name this pin"
        placeholder="e.g. Home, Trailhead…"
        confirmLabel="Save pin"
        onCancel={onDismissPendingPin}
        onConfirm={(value) => {
          if (!pendingPin) return;
          const { lat, lng } = pendingPin;
          const name = value.trim() || `Pin ${lat.toFixed(4)}, ${lng.toFixed(4)}`;
          void data.savePlace({ name, lat, lng });
          onDismissPendingPin();
        }}
      />
    </>
  );
}
