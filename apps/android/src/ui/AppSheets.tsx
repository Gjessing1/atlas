import type { LatLng } from '@atlas/core';
import type {
  MapStyleEditorController,
  MapProfilePreferencesController,
  RegionPackJobsController,
  SyncState,
  ThemeModeController,
  NavPrefsController,
} from '@atlas/app-hooks';

import type { OverlaysController } from '../layers/useOverlays';
import type { TileSource } from '../map/useTileSource';
import type { NavPipController } from '../nav/useNavigationPip';
import type { LocalPack } from '../regions/packs';
import type { OfflinePrefsController } from '../regions/useOfflinePrefs';
import type { PackDownloadsController } from '../regions/usePackDownloads';
import type { ImportOptions, ImportResult, UserData } from '../useUserData';
import type { DestinationTarget } from './DestinationCard';
import { FavoritesSheet, PlaceEditSheet } from './FavoritesSheet';
import { LayersSheet } from './LayersSheet';
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
  /** Place whose focused editor should open (map pin → Edit). */
  editPlaceId: string | null;
  onCloseEditPlace: () => void;
  tracksOpen: boolean;
  onCloseTracks: () => void;
  layersOpen: boolean;
  onCloseLayers: () => void;
  /** Overlay catalog + per-device state for the Layers sheet. */
  overlays: OverlaysController;
  profilePreferences: MapProfilePreferencesController;
  settingsOpen: boolean;
  onCloseSettings: () => void;
  /** Basemap tile source — Settings owns the "stream tiles anyway" switch. */
  tiles: TileSource;
  appearance: ThemeModeController;
  mapStyleEditor: MapStyleEditorController;
  navPrefs: NavPrefsController;
  pip: NavPipController;
  regionJobs: RegionPackJobsController;
  /** Background pack downloads (progress, resume, cancel) and their preferences. */
  downloads: PackDownloadsController;
  offlinePrefs: OfflinePrefsController;
  onDrawRegion: () => void;

  /** Coords awaiting a name before they're saved as a pin (name-on-save prompt). */
  pendingPin: LatLng | null;
  onDismissPendingPin: () => void;

  /** Open the destination card for a favorite/saved place. */
  onPickDestination: (target: DestinationTarget) => void;
  onImportTracks: (options?: ImportOptions) => Promise<ImportResult | null>;
  /** Resolve an iNatur permit link/id and import its boundary as a track. */
  onImportInatur: (input: string, options?: ImportOptions) => Promise<ImportResult | null>;
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
  onCloseEditPlace,
  tracksOpen,
  onCloseTracks,
  layersOpen,
  onCloseLayers,
  overlays,
  profilePreferences,
  settingsOpen,
  onCloseSettings,
  tiles,
  appearance,
  mapStyleEditor,
  navPrefs,
  pip,
  regionJobs,
  downloads,
  offlinePrefs,
  onDrawRegion,
  pendingPin,
  onDismissPendingPin,
  onPickDestination,
  onImportTracks,
  onImportInatur,
}: AppSheetsProps) {
  const editPlace = data.places.find((place) => place.id === editPlaceId) ?? null;
  return (
    <>
      <FavoritesSheet
        visible={favoritesOpen}
        onClose={onCloseFavorites}
        places={data.places}
        collections={data.collections}
        onFlyTo={(place) =>
          onPickDestination({
            lat: place.lat,
            lng: place.lng,
            name: place.name,
            address: place.address || undefined,
            placeId: place.id,
            canSave: false,
          })
        }
        onNavigate={(p) => {
          onCloseFavorites();
          onPickDestination({
            lat: p.lat,
            lng: p.lng,
            name: p.name ?? 'Favorite',
            address: p.address || undefined,
            canSave: false,
          });
        }}
        onPatch={(id, patch) => void data.updatePlace(id, patch)}
        onDelete={(id) => void data.deletePlace(id)}
        onCreateFolder={(name, parentId) => void data.createCollection(name, parentId)}
        onRenameFolder={(id, name) => void data.renameCollection(id, name)}
        onMoveFolder={(id, parentId) => void data.moveCollection(id, parentId)}
        onSetFolderVisible={(id, v) => void data.setCollectionVisible(id, v)}
        onDeleteFolder={(id) => void data.deleteCollection(id)}
        onSetAllVisible={(v) => void data.setAllVisible(v)}
        onReorderPlaces={(ids) => void data.reorderPlaces(ids)}
        onReorderCollections={(ids) => void data.reorderCollections(ids)}
        bottomInset={bottomInset}
      />
      <PlaceEditSheet
        visible={editPlaceId !== null}
        place={editPlace}
        collections={data.collections}
        onPatch={(id, patch) => void data.updatePlace(id, patch)}
        onDelete={(id) => void data.deletePlace(id)}
        onClose={onCloseEditPlace}
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
        collections={data.collections}
        onImport={onImportTracks}
        onImportInatur={onImportInatur}
        onLoadTrackData={(id) => data.getTrackData(id)}
        bottomInset={bottomInset}
      />
      <LayersSheet
        visible={layersOpen}
        onClose={onCloseLayers}
        overlays={overlays}
        bottomInset={bottomInset}
      />
      <SettingsSheet
        visible={settingsOpen}
        onClose={onCloseSettings}
        sync={sync}
        packs={packs}
        onPacksChanged={onPacksChanged}
        storage={data.storage}
        storageState={data}
        tiles={tiles}
        onExportAll={() => void data.exportAll()}
        appearance={appearance}
        mapStyleEditor={mapStyleEditor}
        overlays={overlays}
        profilePreferences={profilePreferences}
        navPrefs={navPrefs}
        pip={pip}
        regionJobs={regionJobs}
        downloads={downloads}
        offlinePrefs={offlinePrefs}
        onDrawRegion={onDrawRegion}
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
