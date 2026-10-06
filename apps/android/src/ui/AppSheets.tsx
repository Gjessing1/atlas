import type {
  MapStyleEditorController,
  MapProfilePreferencesController,
  RegionPackJobsController,
  SyncState,
  GarminState,
  ThemeModeController,
  NavPrefsController,
  VehicleProfileController,
  TransitPreferencesController,
  PinLabelsController,
} from '@atlas/app-hooks';
import type { CollectionRevealTarget, SettingsSectionId } from '@atlas/core';
import type { TrackRecord } from '@atlas/storage';

import type { OverlaysController } from '../layers/useOverlays';
import type { TileSource } from '../map/useTileSource';
import type { NavPipController } from '../nav/useNavigationPip';
import type { NavigationDiagnosticsController } from '../nav/useNavigationDiagnostics';
import type { LocalPack } from '../regions/packs';
import type { OfflinePrefsController } from '../regions/useOfflinePrefs';
import type { PackDownloadsController } from '../regions/usePackDownloads';
import type { ImportOptions, ImportResult, UserData } from '../useUserData';
import type { DestinationTarget } from './DestinationCard';
import { FavoritesSheet, PlaceEditSheet } from './FavoritesSheet';
import { LayersSheet, type KeepOfflineControls } from './LayersSheet';
import { SettingsSheet } from './SettingsSheet';

interface AppSheetsProps {
  data: UserData;
  placeCommutes?: ReadonlyMap<string, readonly string[]>;
  sync: SyncState;
  garmin: GarminState;
  packs: LocalPack[];
  onPacksChanged: () => void;
  bottomInset: number;

  favoritesOpen: boolean;
  revealCollectionItem: CollectionRevealTarget | null;
  onRevealedCollectionItem: () => void;
  /** Open Collections at an item from elsewhere (Settings › Garmin courses). */
  onRevealCollectionItem: (target: CollectionRevealTarget) => void;
  /** Show a saved track on the map by id — it may have been created a moment ago. */
  onShowSavedTrack: (trackId: string) => void;
  onCloseFavorites: () => void;
  /** Place whose focused editor should open (map pin → Edit). */
  editPlaceId: string | null;
  onCloseEditPlace: () => void;
  layersOpen: boolean;
  onCloseLayers: () => void;
  /** "Keep this area offline" for the switched-on derived surface. */
  keepOffline?: KeepOfflineControls;
  /** Overlay catalog + per-device state for the Layers sheet. */
  overlays: OverlaysController;
  profilePreferences: MapProfilePreferencesController;
  settingsOpen: boolean;
  /** Which section Settings should drill into when it opens (deep links). */
  settingsSection?: SettingsSectionId | null;
  onCloseSettings: () => void;
  /** Basemap tile source — Settings owns the "stream tiles anyway" switch. */
  tiles: TileSource;
  appearance: ThemeModeController;
  mapStyleEditor: MapStyleEditorController;
  navPrefs: NavPrefsController;
  vehicle: VehicleProfileController;
  transitPreferences: TransitPreferencesController;
  /** Which folders and tags draw their pins' names (Collections owns the switches). */
  pinLabels: PinLabelsController;
  navDiagnostics: NavigationDiagnosticsController;
  pip: NavPipController;
  regionJobs: RegionPackJobsController;
  /** Background pack downloads (progress, resume, cancel) and their preferences. */
  downloads: PackDownloadsController;
  offlinePrefs: OfflinePrefsController;
  onDrawRegion: () => void;

  /** Open the destination card for a favorite/saved place. */
  onPickDestination: (target: DestinationTarget) => void;
  /** Frame a track on the map and open its profile (a track row's name). */
  onShowTrack: (track: TrackRecord) => void;
  /** Convert a stored/imported track to an editable snapped route. */
  onPlanTrack: (track: TrackRecord) => void;
  onImportTracks: (options?: ImportOptions) => Promise<ImportResult | null>;
  /** Resolve an iNatur permit link/id and import its boundary as a track. */
  onImportInatur: (input: string, options?: ImportOptions) => Promise<ImportResult | null>;
}

/**
 * All modal surfaces above the map: the ☰ sheets (Collections, Layers,
 * Settings) and the focused place editor. Pure wiring between the shared
 * user-data/sync hooks and the sheet components — no logic of its own.
 */
export function AppSheets({
  data,
  placeCommutes,
  sync,
  garmin,
  packs,
  onPacksChanged,
  bottomInset,
  favoritesOpen,
  revealCollectionItem,
  onRevealedCollectionItem,
  onRevealCollectionItem,
  onShowSavedTrack,
  onCloseFavorites,
  editPlaceId,
  onCloseEditPlace,
  layersOpen,
  onCloseLayers,
  keepOffline,
  overlays,
  profilePreferences,
  settingsOpen,
  settingsSection,
  onCloseSettings,
  tiles,
  appearance,
  mapStyleEditor,
  navPrefs,
  vehicle,
  transitPreferences,
  pinLabels,
  navDiagnostics,
  pip,
  regionJobs,
  downloads,
  offlinePrefs,
  onDrawRegion,
  onPickDestination,
  onShowTrack,
  onPlanTrack,
  onImportTracks,
  onImportInatur,
}: AppSheetsProps) {
  const editPlace = data.places.find((place) => place.id === editPlaceId) ?? null;
  return (
    <>
      <FavoritesSheet
        visible={favoritesOpen}
        garmin={garmin}
        onRevealGarminItem={onRevealCollectionItem}
        onShowGarminTrack={(id) => {
          onCloseFavorites();
          onShowSavedTrack(id);
        }}
        revealItem={revealCollectionItem}
        onRevealed={onRevealedCollectionItem}
        onClose={onCloseFavorites}
        places={data.places}
        placeCommutes={placeCommutes}
        tracks={data.tracks}
        collections={data.collections}
        pinLabels={pinLabels}
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
        onShowTrack={onShowTrack}
        onPlanTrack={onPlanTrack}
        onPatchTrack={(id, patch) => void data.updateTrack(id, patch)}
        onDeleteTrack={(id) => void data.deleteTrack(id)}
        onExportTrack={(id, format) => void data.exportTrack(id, format)}
        onCreateFolder={(name, parentId) => void data.createCollection(name, parentId)}
        onRenameFolder={(id, name) => void data.renameCollection(id, name)}
        onMoveFolder={(id, parentId) => void data.moveCollection(id, parentId)}
        onSetFolderVisible={(id, v) => void data.setCollectionVisible(id, v)}
        onDeleteFolder={(id) => void data.deleteCollection(id)}
        onSetAllVisible={(v) => void data.setAllVisible(v)}
        onShowOnlyTracks={(ids) => void data.showOnlyTracks(ids)}
        onExportAll={() => void data.exportAll()}
        onImport={onImportTracks}
        onImportInatur={onImportInatur}
        onDrop={(drag, target, zone) => void data.arrangeCollectionItem(drag, target, zone)}
        bottomInset={bottomInset}
      />
      <PlaceEditSheet
        visible={editPlaceId !== null}
        place={editPlace}
        collections={data.collections}
        places={data.places}
        tracks={data.tracks}
        onPatch={(id, patch) => void data.updatePlace(id, patch)}
        onDelete={(id) => void data.deletePlace(id)}
        onClose={onCloseEditPlace}
        bottomInset={bottomInset}
      />
      <LayersSheet
        visible={layersOpen}
        onClose={onCloseLayers}
        overlays={overlays}
        keepOffline={keepOffline}
        bottomInset={bottomInset}
      />
      <SettingsSheet
        visible={settingsOpen}
        section={settingsSection}
        onClose={onCloseSettings}
        sync={sync}
        garmin={garmin}
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
        vehicle={vehicle}
        transitPreferences={transitPreferences}
        navDiagnostics={navDiagnostics}
        pip={pip}
        regionJobs={regionJobs}
        downloads={downloads}
        offlinePrefs={offlinePrefs}
        onDrawRegion={onDrawRegion}
        bottomInset={bottomInset}
      />
    </>
  );
}
