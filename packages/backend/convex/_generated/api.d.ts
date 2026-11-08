/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as atlas from "../atlas.js";
import type * as atlasBalance from "../atlasBalance.js";
import type * as atlasConfig from "../atlasConfig.js";
import type * as atlasFavorites from "../atlasFavorites.js";
import type * as atlasProcessor from "../atlasProcessor.js";
import type * as authz from "../authz.js";
import type * as chatCompletion from "../chatCompletion.js";
import type * as comfyVideo from "../comfyVideo.js";
import type * as comfyVideoProcessor from "../comfyVideoProcessor.js";
import type * as comfyuiProgressReporter from "../comfyuiProgressReporter.js";
import type * as comfyuiTarget from "../comfyuiTarget.js";
import type * as config from "../config.js";
import type * as crons from "../crons.js";
import type * as enhanceProcessor from "../enhanceProcessor.js";
import type * as enhanceRecipes from "../enhanceRecipes.js";
import type * as enhancements from "../enhancements.js";
import type * as failures from "../failures.js";
import type * as falConfig from "../falConfig.js";
import type * as falProcessor from "../falProcessor.js";
import type * as favoriteFolders from "../favoriteFolders.js";
import type * as favorites from "../favorites.js";
import type * as featureFlags from "../featureFlags.js";
import type * as generationProcessor from "../generationProcessor.js";
import type * as generations from "../generations.js";
import type * as grokAuth from "../grokAuth.js";
import type * as grokAuthActions from "../grokAuthActions.js";
import type * as grokConfig from "../grokConfig.js";
import type * as grokGenerations from "../grokGenerations.js";
import type * as grokProcessor from "../grokProcessor.js";
import type * as grokToken from "../grokToken.js";
import type * as h3Validators from "../h3Validators.js";
import type * as higgsfield from "../higgsfield.js";
import type * as higgsfieldConfig from "../higgsfieldConfig.js";
import type * as higgsfieldProcessor from "../higgsfieldProcessor.js";
import type * as http from "../http.js";
import type * as imageToPrompt from "../imageToPrompt.js";
import type * as mediaPipeline from "../mediaPipeline.js";
import type * as podCatalog from "../podCatalog.js";
import type * as podClient from "../podClient.js";
import type * as podDownloads from "../podDownloads.js";
import type * as podLaunchModels from "../podLaunchModels.js";
import type * as podModels from "../podModels.js";
import type * as podSubmit from "../podSubmit.js";
import type * as promptEnhance from "../promptEnhance.js";
import type * as promptStudio from "../promptStudio.js";
import type * as promptStudioRun from "../promptStudioRun.js";
import type * as promptStudioValidators from "../promptStudioValidators.js";
import type * as provisionScript from "../provisionScript.js";
import type * as runpodBackendActions from "../runpodBackendActions.js";
import type * as runpodBackendStore from "../runpodBackendStore.js";
import type * as savedPrompts from "../savedPrompts.js";
import type * as savedSearches from "../savedSearches.js";
import type * as searchCatalog from "../searchCatalog.js";
import type * as selfHostedSelection from "../selfHostedSelection.js";
import type * as vastBackendActions from "../vastBackendActions.js";
import type * as vastBackendStore from "../vastBackendStore.js";
import type * as videos from "../videos.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  atlas: typeof atlas;
  atlasBalance: typeof atlasBalance;
  atlasConfig: typeof atlasConfig;
  atlasFavorites: typeof atlasFavorites;
  atlasProcessor: typeof atlasProcessor;
  authz: typeof authz;
  chatCompletion: typeof chatCompletion;
  comfyVideo: typeof comfyVideo;
  comfyVideoProcessor: typeof comfyVideoProcessor;
  comfyuiProgressReporter: typeof comfyuiProgressReporter;
  comfyuiTarget: typeof comfyuiTarget;
  config: typeof config;
  crons: typeof crons;
  enhanceProcessor: typeof enhanceProcessor;
  enhanceRecipes: typeof enhanceRecipes;
  enhancements: typeof enhancements;
  failures: typeof failures;
  falConfig: typeof falConfig;
  falProcessor: typeof falProcessor;
  favoriteFolders: typeof favoriteFolders;
  favorites: typeof favorites;
  featureFlags: typeof featureFlags;
  generationProcessor: typeof generationProcessor;
  generations: typeof generations;
  grokAuth: typeof grokAuth;
  grokAuthActions: typeof grokAuthActions;
  grokConfig: typeof grokConfig;
  grokGenerations: typeof grokGenerations;
  grokProcessor: typeof grokProcessor;
  grokToken: typeof grokToken;
  h3Validators: typeof h3Validators;
  higgsfield: typeof higgsfield;
  higgsfieldConfig: typeof higgsfieldConfig;
  higgsfieldProcessor: typeof higgsfieldProcessor;
  http: typeof http;
  imageToPrompt: typeof imageToPrompt;
  mediaPipeline: typeof mediaPipeline;
  podCatalog: typeof podCatalog;
  podClient: typeof podClient;
  podDownloads: typeof podDownloads;
  podLaunchModels: typeof podLaunchModels;
  podModels: typeof podModels;
  podSubmit: typeof podSubmit;
  promptEnhance: typeof promptEnhance;
  promptStudio: typeof promptStudio;
  promptStudioRun: typeof promptStudioRun;
  promptStudioValidators: typeof promptStudioValidators;
  provisionScript: typeof provisionScript;
  runpodBackendActions: typeof runpodBackendActions;
  runpodBackendStore: typeof runpodBackendStore;
  savedPrompts: typeof savedPrompts;
  savedSearches: typeof savedSearches;
  searchCatalog: typeof searchCatalog;
  selfHostedSelection: typeof selfHostedSelection;
  vastBackendActions: typeof vastBackendActions;
  vastBackendStore: typeof vastBackendStore;
  videos: typeof videos;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
