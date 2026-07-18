import { requireOptionalNativeModule } from 'expo-modules-core';

/**
 * Transient audio-focus bridge for voice guidance: holding
 * AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK makes music/podcast apps lower their
 * volume while a navigation prompt speaks (expo-speech itself never asks for
 * focus, so prompts used to talk over media at full blast). Request before
 * the first queued utterance, abandon after the last.
 */
export interface AudioFocusNativeModule {
  /** Take transient may-duck focus; true if the system granted it. */
  requestDuck(): boolean;
  /** Give focus back so other media returns to full volume. */
  abandon(): void;
}

/** Null in app builds that predate the native module — prompts still play, just without ducking. */
export const AudioFocus = requireOptionalNativeModule<AudioFocusNativeModule>('AudioFocus');
