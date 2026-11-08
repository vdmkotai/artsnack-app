//! `packages/shared/search.test.ts`, case for case. A failure here means the
//! native search and the web's disagree.

use std::{collections::BTreeMap, sync::Arc};

use artsnack_backend::api::{
    favorites::MediaType,
    search_catalog::{ParameterValue, SearchAsset, SearchDocument, SearchSource},
};

use super::{
    text::{collate, edit_distance_at_most_one},
    *,
};

fn asset(id: &str, key: &str) -> SearchAsset {
    SearchAsset {
        id: id.into(),
        key: key.into(),
        thumbnail_key: None,
    }
}

/// The test file's `base` document.
fn base() -> SearchDocument {
    SearchDocument {
        id: "one".into(),
        source: SearchSource::SelfHosted,
        provider: "self-hosted".into(),
        media_type: MediaType::Image,
        created_at: 1.0,
        prompt: "2dogs, on_beach, red silkscarf".into(),
        negative_prompt: Some("blurry, bad hands".into()),
        assets: vec![asset("asset", "image.png")],
        model: None,
        model_label: None,
        model_family: None,
        checkpoints: vec!["sdxl_base.safetensors".into()],
        loras: vec!["Details".into(), "Lighting".into()],
        width: None,
        height: None,
        aspect_ratio: None,
        resolution: None,
        quality: None,
        duration: None,
        has_references: false,
        sampler: None,
        scheduler: None,
        steps: None,
        cfg: None,
        seed: None,
        parameters: None,
        local_settings: None,
    }
}

fn catalog(documents: impl IntoIterator<Item = SearchDocument>) -> Vec<Arc<CatalogDocument>> {
    documents
        .into_iter()
        .map(|document| Arc::new(CatalogDocument::new(Arc::new(document))))
        .collect()
}

fn intent(query: &str) -> SearchIntent {
    SearchIntent {
        query: query.into(),
        ..SearchIntent::default()
    }
}

fn result_count(intent: SearchIntent) -> isize {
    match search_documents(&catalog([base()]), &intent) {
        Ok(output) => output.results.len() as isize,
        Err(_) => -1,
    }
}

fn run(query: &str) -> isize {
    result_count(intent(query))
}

fn typos(query: &str) -> isize {
    result_count(SearchIntent {
        allow_typos: true,
        ..intent(query)
    })
}

fn params(entries: &[(&str, ParameterValue)]) -> Option<BTreeMap<String, ParameterValue>> {
    Some(
        entries
            .iter()
            .map(|(name, value)| (name.to_string(), value.clone()))
            .collect(),
    )
}

fn text(value: &str) -> ParameterValue {
    ParameterValue::Text(value.into())
}

fn list(values: &[&str]) -> ParameterValue {
    ParameterValue::List(values.iter().map(|value| value.to_string()).collect())
}

fn facet(value: &str, count: usize) -> FacetValue {
    FacetValue {
        value: value.into(),
        count,
    }
}

fn ids(output: &SearchOutput) -> Vec<String> {
    output
        .results
        .iter()
        .map(|result| result.document.id.clone())
        .collect()
}

// --- search query grammar ---------------------------------------------------

#[test]
fn supports_broad_contains_exact_tokens_phrases_exclusions_and_or() {
    assert_eq!(run("dog, beach"), 1);
    assert_eq!(run("\"dog\""), 0);
    assert_eq!(run("\"2dogs\""), 1);
    assert_eq!(run("\"on beach\""), 1);
    assert_eq!(run("dog, beach, -scarf"), 0);
    assert_eq!(run("dog, -\"scarf\""), 1);
    assert_eq!(run("fox|dog, beach"), 1);
}

#[test]
fn reports_malformed_syntax_instead_of_guessing() {
    assert_eq!(
        parse_search_query("dog, \"beach"),
        Err(SearchSyntaxError {
            message: "Close the quoted phrase with another quote.",
            at: 5,
        })
    );
    assert!(parse_search_query("dog|").is_err());
    assert!(parse_search_query("(dog|fox)").is_err());
}

#[test]
fn fuzzy_matching_is_opt_in_positive_only_and_length_limited() {
    assert_eq!(typos("bech"), 0);
    assert_eq!(typos("beahc"), 0);
    assert_eq!(typos("beacg"), 1);
    assert_eq!(typos("\"beacg\""), 0);
}

#[test]
fn searches_negative_prompts_only_through_their_explicit_field() {
    assert_eq!(run("blurry"), 0);
    let negative = |query: &str| {
        result_count(SearchIntent {
            negative_prompt_query: query.into(),
            ..intent("dog")
        })
    };
    assert_eq!(negative("blurry"), 1);
    assert_eq!(negative("sharp"), 0);
}

// --- search filtering and persistence ----------------------------------------

#[test]
fn supports_lora_any_all_and_historical_checkpoint_values() {
    let with = |filters: SearchFilters| {
        result_count(SearchIntent {
            filters,
            ..SearchIntent::default()
        })
    };
    let loras = vec!["Details".to_string(), "Missing".to_string()];
    assert_eq!(
        with(SearchFilters {
            loras: loras.clone(),
            lora_mode: LoraMode::Any,
            ..SearchFilters::default()
        }),
        1
    );
    assert_eq!(
        with(SearchFilters {
            loras,
            lora_mode: LoraMode::All,
            ..SearchFilters::default()
        }),
        0
    );
    assert_eq!(
        with(SearchFilters {
            checkpoints: vec!["sdxl_base.safetensors".into()],
            ..SearchFilters::default()
        }),
        1
    );
}

#[test]
fn round_trips_a_search_intent_through_a_url() {
    let intent = SearchIntent {
        query: "dog|fox, beach, -\"scarf\"".into(),
        allow_typos: true,
        sort: SearchSort::Oldest,
        filters: SearchFilters {
            providers: vec!["atlas".into()],
            loras: vec!["Details".into()],
            lora_mode: LoraMode::All,
            parameters: [("motion".to_string(), vec!["high".to_string()])].into(),
            ..SearchFilters::default()
        },
        ..SearchIntent::default()
    };
    assert_eq!(
        deserialize_search_intent(&serialize_search_intent(&intent)),
        intent
    );
}

#[test]
fn sanitizes_hand_edited_and_stale_filter_payloads() {
    let filters = serde_json::json!({
        "mediaTypes": null,
        "providers": ["atlas", "not-a-provider", 123],
        "loraMode": "invalid",
        "stepsMin": "20",
        "parameters": { "motion": "high", "quality": ["pro", false] }
    });
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("filters", &filters.to_string())
        .finish();
    assert_eq!(
        deserialize_search_intent(&query).filters,
        SearchFilters {
            providers: vec!["atlas".into()],
            parameters: [("quality".to_string(), vec!["pro".to_string()])].into(),
            ..SearchFilters::default()
        }
    );
}

#[test]
fn ranks_exact_tokens_above_broad_contains_and_uses_recency_only_as_a_tie_breaker() {
    let documents = catalog([
        SearchDocument {
            id: "new-contains".into(),
            created_at: 30.0,
            prompt: "2dogs".into(),
            ..base()
        },
        SearchDocument {
            id: "old-exact".into(),
            created_at: 10.0,
            prompt: "dog".into(),
            ..base()
        },
        SearchDocument {
            id: "new-exact".into(),
            created_at: 20.0,
            prompt: "dog".into(),
            ..base()
        },
    ]);
    let output = search_documents(&documents, &intent("dog")).unwrap();
    assert_eq!(ids(&output), ["new-exact", "old-exact", "new-contains"]);
}

#[test]
fn filters_provider_parameters_and_expands_a_matching_generation_into_every_asset() {
    let api = SearchDocument {
        id: "atlas-video".into(),
        source: SearchSource::Api,
        provider: "atlas".into(),
        media_type: MediaType::Video,
        prompt: "dog walking on beach".into(),
        assets: vec![asset("a", "a.mp4"), asset("b", "b.mp4")],
        model: Some("wan".into()),
        checkpoints: Vec::new(),
        loras: Vec::new(),
        duration: Some(10.0),
        has_references: true,
        parameters: params(&[("motion", text("high")), ("camera", list(&["pan", "zoom"]))]),
        ..base()
    };
    let output = search_documents(
        &catalog([base(), api]),
        &SearchIntent {
            filters: SearchFilters {
                media_types: vec![MediaType::Video],
                providers: vec!["atlas".into()],
                duration_min: Some(8.0),
                has_references: Some(true),
                parameters: [
                    ("motion".to_string(), vec!["high".to_string()]),
                    ("camera".to_string(), vec!["zoom".to_string()]),
                ]
                .into(),
                ..SearchFilters::default()
            },
            ..intent("beach")
        },
    )
    .unwrap();
    assert_eq!(output.documents.len(), 1);
    let assets: Vec<&str> = output
        .results
        .iter()
        .map(|result| result.asset().id.as_str())
        .collect();
    assert_eq!(assets, ["a", "b"]);
}

#[test]
fn covers_the_complete_scalar_and_facet_filter_matrix_at_inclusive_boundaries() {
    let rich = SearchDocument {
        source: SearchSource::Api,
        provider: "atlas".into(),
        media_type: MediaType::Video,
        created_at: 1_000.0,
        model: Some("wan-2.7".into()),
        model_family: Some("WAN".into()),
        checkpoints: vec!["high.safetensors".into(), "low.safetensors".into()],
        loras: vec!["motion.safetensors".into()],
        width: Some(1920.0),
        height: Some(1080.0),
        resolution: Some("1080p".into()),
        quality: Some("pro".into()),
        duration: Some(10.0),
        has_references: true,
        sampler: Some("euler".into()),
        scheduler: Some("normal".into()),
        steps: Some(30.0),
        cfg: Some(7.5),
        seed: Some(42.0),
        parameters: params(&[("motion", text("high"))]),
        ..base()
    };
    let filters = SearchFilters {
        media_types: vec![MediaType::Video],
        sources: vec![SearchSource::Api],
        providers: vec!["atlas".into()],
        models: vec!["wan-2.7".into()],
        model_families: vec!["WAN".into()],
        checkpoints: vec!["low.safetensors".into()],
        loras: vec!["motion.safetensors".into()],
        lora_mode: LoraMode::All,
        created_after: Some(1_000.0),
        created_before: Some(1_000.0),
        orientations: vec![Orientation::Landscape],
        resolutions: vec!["1080p".into()],
        qualities: vec!["pro".into()],
        duration_min: Some(10.0),
        duration_max: Some(10.0),
        has_references: Some(true),
        samplers: vec!["euler".into()],
        schedulers: vec!["normal".into()],
        steps_min: Some(30.0),
        steps_max: Some(30.0),
        cfg_min: Some(7.5),
        cfg_max: Some(7.5),
        seed: Some(42.0),
        width_min: Some(1920.0),
        width_max: Some(1920.0),
        height_min: Some(1080.0),
        height_max: Some(1080.0),
        parameters: [("motion".to_string(), vec!["high".to_string()])].into(),
    };
    let documents = catalog([rich]);
    let matching = search_documents(
        &documents,
        &SearchIntent {
            filters: filters.clone(),
            ..SearchIntent::default()
        },
    )
    .unwrap();
    let outside_boundary = search_documents(
        &documents,
        &SearchIntent {
            filters: SearchFilters {
                steps_min: Some(31.0),
                ..filters
            },
            ..SearchIntent::default()
        },
    )
    .unwrap();
    assert_eq!(matching.results.len(), 1);
    assert_eq!(outside_boundary.results.len(), 0);
}

#[test]
fn builds_generation_level_facets_and_counts_grouped_active_filters() {
    let two = SearchDocument {
        id: "two".into(),
        provider: "atlas".into(),
        loras: vec!["Details".into()],
        model: Some("wan".into()),
        ..base()
    };
    let documents = [base(), two];
    let facets = build_search_facets(documents.iter());
    assert_eq!(
        facets.providers,
        [facet("atlas", 1), facet("self-hosted", 1)]
    );
    assert_eq!(facets.loras, [facet("Details", 2), facet("Lighting", 1)]);
    assert_eq!(
        count_active_search_filters(&SearchFilters {
            providers: vec!["atlas".into()],
            steps_min: Some(20.0),
            has_references: Some(false),
            parameters: [("motion".to_string(), vec!["high".to_string()])].into(),
            ..SearchFilters::default()
        }),
        4
    );
}

#[test]
fn normalizes_unicode_compatibility_forms_and_ignores_empty_asset_documents() {
    assert_eq!(
        normalize_search_text("\u{FF24}\u{FF4F}\u{FF47}_on-BEACH!!!"),
        "dog on beach"
    );
    let output = search_documents(
        &catalog([SearchDocument {
            assets: Vec::new(),
            ..base()
        }]),
        &SearchIntent::default(),
    )
    .unwrap();
    assert_eq!(output.results.len(), 0);
}

#[test]
fn supports_explicit_newest_and_oldest_ordering() {
    let older = || SearchDocument {
        id: "older".into(),
        created_at: 1.0,
        ..base()
    };
    let newer = || SearchDocument {
        id: "newer".into(),
        created_at: 2.0,
        ..base()
    };
    let sorted = |documents: Vec<SearchDocument>, sort| {
        let output = search_documents(
            &catalog(documents),
            &SearchIntent {
                sort,
                ..SearchIntent::default()
            },
        )
        .unwrap();
        ids(&output)
    };
    assert_eq!(
        sorted(vec![older(), newer()], SearchSort::Newest),
        ["newer", "older"]
    );
    assert_eq!(
        sorted(vec![newer(), older()], SearchSort::Oldest),
        ["older", "newer"]
    );
}

#[test]
fn keeps_ordered_image_references_enforces_capacity_and_rejects_videos() {
    let result = |id: &str, media_type: MediaType| SearchResult {
        document: Arc::new(SearchDocument {
            id: id.into(),
            media_type,
            ..base()
        }),
        asset_ix: 0,
        score: 0,
        reasons: Arc::from(Vec::new()),
    };
    let image = |id: &str| result(id, MediaType::Image);
    let ids = |references: &[SearchResult]| -> Vec<String> {
        references
            .iter()
            .map(|reference| reference.document.id.clone())
            .collect()
    };
    let first = image("first");
    let second = image("second");
    assert!(
        toggle_search_reference(
            &[],
            &result("video", MediaType::Video),
            MAX_SEARCH_REFERENCES
        )
        .is_empty()
    );
    assert_eq!(
        ids(&toggle_search_reference(
            std::slice::from_ref(&first),
            &second,
            1
        )),
        ["first"]
    );
    assert!(
        toggle_search_reference(std::slice::from_ref(&first), &first, MAX_SEARCH_REFERENCES)
            .is_empty()
    );
    let thirty: Vec<SearchResult> = (0..30).map(|ix| image(&format!("ref-{ix}"))).collect();
    assert_eq!(
        toggle_search_reference(&thirty[..29], &thirty[29], MAX_SEARCH_REFERENCES).len(),
        30
    );
    assert_eq!(
        toggle_search_reference(&thirty, &image("ref-30"), MAX_SEARCH_REFERENCES).len(),
        30
    );
    let pair = [first.clone(), second.clone()];
    assert_eq!(
        ids(&reorder_search_references(&pair, 0, 1)),
        ["second", "first"]
    );
    // The web's `-1`: a position outside the list changes nothing.
    assert_eq!(
        ids(&reorder_search_references(&pair, 5, 1)),
        ["first", "second"]
    );
}

#[test]
fn keeps_the_last_valid_result_set_while_a_query_has_a_syntax_error() {
    let documents = catalog([base()]);
    let valid = resolve_search_output(
        &documents,
        &intent("beach"),
        Arc::new(SearchOutput::default()),
    );
    let invalid = resolve_search_output(&documents, &intent("\"beach"), valid.last_valid.clone());
    assert_eq!(valid.output.results.len(), 1);
    assert!(Arc::ptr_eq(&invalid.output, &valid.output));
    assert!(
        invalid
            .syntax_error
            .unwrap_or_default()
            .contains("Close the quoted phrase")
    );
}

#[test]
fn compares_canonical_intents_so_the_same_return_url_does_not_reset_session_state() {
    let linked = deserialize_search_intent(&serialize_search_intent(&SearchIntent {
        filters: SearchFilters {
            providers: vec!["atlas".into()],
            ..SearchFilters::default()
        },
        ..intent("beach")
    }));
    assert!(same_search_intent(&linked, &linked.clone()));
    assert!(!same_search_intent(
        &linked,
        &SearchIntent {
            query: "scarf".into(),
            ..linked.clone()
        }
    ));
}

#[test]
fn restores_local_search_history_defensively_and_keeps_newest_unique_entries() {
    assert!(parse_search_history(Some("not json"), 20).is_empty());
    assert!(parse_search_history(Some(r#"{"query":"beach"}"#), 20).is_empty());
    assert_eq!(
        parse_search_history(Some(r#"["beach",12,"dog"]"#), 20),
        ["beach", "dog"]
    );
    let previous = ["dog".to_string(), "beach".into(), "scarf".into()];
    assert_eq!(
        add_search_history(&previous, "beach", 3),
        ["beach", "dog", "scarf"]
    );
}

// --- search performance contracts --------------------------------------------

fn atlas(ix: usize, parameters: Option<BTreeMap<String, ParameterValue>>) -> SearchDocument {
    SearchDocument {
        id: format!("atlas-{ix}"),
        source: SearchSource::Api,
        provider: "atlas".into(),
        created_at: ix as f64,
        prompt: format!("dog on beach number {ix}"),
        checkpoints: Vec::new(),
        loras: Vec::new(),
        parameters,
        ..base()
    }
}

#[test]
fn counts_provider_parameter_values_in_place_across_arrays_and_documents() {
    let documents = [
        atlas(
            1,
            params(&[
                ("motion", text("high")),
                ("camera", list(&["pan", "zoom"])),
                ("audio", ParameterValue::Flag(true)),
                ("empty", list(&[])),
            ]),
        ),
        atlas(
            2,
            params(&[
                ("motion", text("high")),
                ("camera", list(&["zoom"])),
                ("audio", ParameterValue::Flag(false)),
                ("steps", ParameterValue::Number(0.0)),
            ]),
        ),
        atlas(
            3,
            params(&[
                ("motion", text("low")),
                ("camera", text("zoom")),
                ("blank", text("")),
            ]),
        ),
        base(),
    ];
    let facets = collect_parameter_facets(documents.iter());
    let expected: BTreeMap<String, Vec<FacetValue>> = [
        ("motion", vec![facet("high", 2), facet("low", 1)]),
        ("camera", vec![facet("zoom", 3), facet("pan", 1)]),
        ("audio", vec![facet("false", 1), facet("true", 1)]),
        ("empty", vec![]),
        ("steps", vec![facet("0", 1)]),
        ("blank", vec![]),
    ]
    .into_iter()
    .map(|(name, values)| (name.to_string(), values))
    .collect();
    assert_eq!(facets, expected);
}

#[test]
fn leaves_free_text_and_media_parameters_out_of_facets_but_still_filters_by_them() {
    let document = atlas(
        1,
        params(&[
            ("prompt", text("dog on beach number 1")),
            ("image", text("https://media.example/1.png")),
            ("images", list(&["https://media.example/2.png"])),
            ("video", text("https://media.example/1.mp4")),
            ("url", text("https://media.example/")),
            ("negative_prompt", text("blurry")),
        ]),
    );
    let names: Vec<String> = build_search_facets([&document])
        .parameters
        .into_keys()
        .collect();
    assert_eq!(names, ["negative_prompt"]);
    let filtered = search_documents(
        &catalog([document]),
        &SearchIntent {
            filters: SearchFilters {
                parameters: [(
                    "prompt".to_string(),
                    vec!["dog on beach number 1".to_string()],
                )]
                .into(),
                ..SearchFilters::default()
            },
            ..SearchIntent::default()
        },
    )
    .unwrap();
    assert_eq!(filtered.results.len(), 1);
}

#[test]
fn builds_facets_for_a_large_history_in_linear_time() {
    let documents: Vec<SearchDocument> = (0..20_000)
        .map(|ix| {
            atlas(
                ix,
                params(&[
                    ("seed", ParameterValue::Number(ix as f64)),
                    ("motion", text(if ix % 2 == 1 { "high" } else { "low" })),
                    ("camera", list(&["pan", "zoom"])),
                ]),
            )
        })
        .collect();
    let started = std::time::Instant::now();
    let facets = build_search_facets(documents.iter());
    let elapsed = started.elapsed();
    assert_eq!(facets.parameters["seed"].len(), 20_000);
    assert_eq!(
        facets.parameters["camera"],
        [facet("pan", 20_000), facet("zoom", 20_000)]
    );
    // The web's budget is 250 ms; an unoptimised test build gets more room.
    assert!(
        elapsed.as_millis() < 2_000,
        "facets for 20,000 documents took {elapsed:?}"
    );
}

#[test]
fn counts_exactly_the_media_search_documents_would_return() {
    let documents = catalog([
        base(),
        SearchDocument {
            id: "video".into(),
            media_type: MediaType::Video,
            assets: vec![asset("asset", "image.png"), asset("b", "b")],
            ..base()
        },
        SearchDocument {
            id: "fox".into(),
            prompt: "fox in forest".into(),
            negative_prompt: Some("sharp".into()),
            ..base()
        },
        SearchDocument {
            id: "empty".into(),
            assets: Vec::new(),
            ..base()
        },
    ]);
    let intents = [
        SearchIntent::default(),
        intent("dog"),
        intent("dog|fox, -scarf"),
        SearchIntent {
            negative_prompt_query: "sharp".into(),
            ..intent("forest")
        },
        SearchIntent {
            allow_typos: true,
            ..intent("beahc")
        },
        SearchIntent {
            filters: SearchFilters {
                media_types: vec![MediaType::Video],
                ..SearchFilters::default()
            },
            ..SearchIntent::default()
        },
    ];
    for intent in &intents {
        let output = search_documents(&documents, intent).unwrap();
        assert_eq!(
            count_search_matches(&documents, intent),
            output.results.len(),
            "{}",
            intent.query
        );
    }
    assert_eq!(count_search_matches(&documents, &intent("\"dog")), 0);
}

#[test]
fn reports_the_first_malformed_query_of_an_intent() {
    assert_eq!(search_intent_error(&SearchIntent::default()), None);
    assert!(
        search_intent_error(&intent("\"beach"))
            .unwrap_or_default()
            .contains("Close the quoted phrase")
    );
    assert!(
        search_intent_error(&SearchIntent {
            negative_prompt_query: "blurry|".into(),
            ..SearchIntent::default()
        })
        .unwrap_or_default()
        .contains("alternative")
    );
}

#[test]
fn keeps_result_identity_for_unchanged_documents_and_only_replaces_what_changed() {
    let first_document = Arc::new(CatalogDocument::new(Arc::new(base())));
    let second_document = Arc::new(CatalogDocument::new(Arc::new(SearchDocument {
        id: "second".into(),
        created_at: 2.0,
        ..base()
    })));
    let results = |documents: &[Arc<CatalogDocument>]| {
        search_documents(
            documents,
            &SearchIntent {
                sort: SearchSort::Newest,
                ..SearchIntent::default()
            },
        )
        .unwrap()
        .results
    };
    let first = results(&[first_document.clone(), second_document.clone()]);
    let same = stabilize_search_results(
        &first,
        results(&[first_document.clone(), second_document.clone()]),
    );
    assert!(
        Arc::ptr_eq(&same, &first),
        "an unchanged search keeps the previous list"
    );

    let edited = Arc::new(CatalogDocument::new(Arc::new(SearchDocument {
        prompt: "edited".into(),
        ..second_document.document().as_ref().clone()
    })));
    let changed =
        stabilize_search_results(&first, results(&[first_document.clone(), edited.clone()]));
    assert!(!Arc::ptr_eq(&changed, &first));
    assert!(
        changed[1].is_same(&first[1]),
        "the untouched document keeps its result"
    );
    assert!(!changed[0].is_same(&first[0]));
    assert!(Arc::ptr_eq(&changed[0].document, edited.document()));

    let third = Arc::new(CatalogDocument::new(Arc::new(SearchDocument {
        id: "third".into(),
        created_at: 3.0,
        ..base()
    })));
    let grown =
        stabilize_search_results(&first, results(&[first_document, second_document, third]));
    assert_eq!(grown.len(), 3);
    assert!(grown[1].is_same(&first[0]));
    assert!(grown[2].is_same(&first[1]));
}

// --- native-only details ------------------------------------------------------

#[test]
fn counts_typos_in_utf16_units_like_the_web() {
    assert!(edit_distance_at_most_one("beach", "beacg"));
    assert!(!edit_distance_at_most_one("beach", "beaches"));
    assert!(edit_distance_at_most_one("пляж", "пляжи"));
    // An astral character is two UTF-16 units, so swapping one for an ASCII
    // letter is two edits on the web, too.
    assert!(!edit_distance_at_most_one("a\u{1F600}b", "axb"));
    // One substitution, deletion or insertion anywhere; two of them, no.
    assert!(edit_distance_at_most_one("пляж", "плаж"));
    assert!(edit_distance_at_most_one("пляжи", "пляж"));
    assert!(edit_distance_at_most_one("пляж", "пдляж"));
    assert!(!edit_distance_at_most_one("пляж", "пляжик"));
    assert!(!edit_distance_at_most_one("пляж", "плаш"));
    assert!(edit_distance_at_most_one("beach", "bech"));
    assert!(!edit_distance_at_most_one("beach", "bexcx"));
}

#[test]
fn matches_letters_and_numbers_as_unicode_classes() {
    assert_eq!(normalize_search_text("Привет, МИР_2"), "привет мир 2");
    // A decomposed accent composes under NFKC instead of splitting the word.
    assert_eq!(normalize_search_text("cafe\u{301} au lait"), "café au lait");
    assert_eq!(tokenize_search_text("  --  "), Vec::<String>::new());
}

#[test]
fn orders_facet_ties_like_a_collator() {
    use std::cmp::Ordering::*;
    assert_eq!(collate("atlas", "self-hosted"), Less);
    assert_eq!(collate("a", "A"), Less);
    assert_eq!(collate("A", "b"), Less);
    assert_eq!(collate("é", "f"), Less);
    assert_eq!(collate("_x", "1"), Less);
    assert_eq!(collate("1", "a"), Less);
    // Punctuation in CLDR order, not by code point, as Node's ICU sorts it:
    // `["ab","a1","a.b","a-b","a_b","a b"].sort(new Intl.Collator().compare)`.
    let mut values = vec!["ab", "a1", "a.b", "a-b", "a_b", "a b", "a\u{2013}b", "a$b"];
    values.sort_by(|left, right| collate(left, right));
    assert_eq!(
        values,
        ["a b", "a_b", "a-b", "a\u{2013}b", "a.b", "a$b", "a1", "ab"]
    );
    assert_eq!(collate("~", "$"), Less);
    assert_eq!(collate("x10", "x2"), Less);
}

#[test]
fn writes_saved_search_filters_as_the_web_does() {
    let serialized = serialize_search_intent(&SearchIntent {
        filters: SearchFilters {
            steps_min: Some(20.0),
            cfg_max: Some(7.5),
            ..SearchFilters::default()
        },
        ..intent("red dress")
    });
    assert!(serialized.starts_with("q=red+dress&filters="));
    assert!(serialized.contains("%22stepsMin%22%3A20%2C"));
    assert!(serialized.contains("%22cfgMax%22%3A7.5"));
}

#[test]
fn a_text_phase_serves_every_filter_and_sort_the_same_as_a_fresh_search() {
    let documents = catalog([
        SearchDocument {
            id: "old".into(),
            created_at: 1.0,
            checkpoints: vec!["a.safetensors".into()],
            ..base()
        },
        SearchDocument {
            id: "new".into(),
            created_at: 2.0,
            checkpoints: vec!["b.safetensors".into()],
            ..base()
        },
        SearchDocument {
            id: "other".into(),
            created_at: 3.0,
            prompt: "a dog on a sofa".into(),
            ..base()
        },
    ]);
    let query = intent("beach");
    let text = match_search_text_until(&documents, &query, || false)
        .unwrap()
        .unwrap();
    for (sort, checkpoints) in [
        (SearchSort::Newest, vec![]),
        (SearchSort::Oldest, vec![]),
        (SearchSort::Relevance, vec!["a.safetensors".to_string()]),
    ] {
        let changed = SearchIntent {
            sort,
            filters: SearchFilters {
                checkpoints,
                ..SearchFilters::default()
            },
            ..query.clone()
        };
        let reused = finish_search_until(&text, &changed, || false).unwrap();
        let fresh = search_documents(&documents, &changed).unwrap();
        assert_eq!(ids(&reused), ids(&fresh));
        assert_eq!(reused.facets, fresh.facets);
    }
    // A newer search makes the rest give up.
    assert!(finish_search_until(&text, &query, || true).is_none());
}
