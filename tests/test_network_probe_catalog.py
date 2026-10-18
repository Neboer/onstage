import argparse
import copy
import json
from pathlib import Path

import pytest

from tools.network_probe import Probe, ProbeError, request_json, select_catalog_stickers


def small_catalog():
    return {"stickers": [
        {"id": "mygo.test", "character_id": "mygo.tomori"},
        {"id": "mujica.test", "character_id": "mujica.sakiko"},
        {"id": "user.test", "character_id": None, "source_category": "真奈"},
    ]}


def test_current_catalog_includes_supplementary_without_adding_a_role():
    catalog = json.loads((Path(__file__).resolve().parents[1] / "app/catalog.json").read_text(encoding="utf-8"))
    original = copy.deepcopy(catalog)
    selected, supplementary = select_catalog_stickers(catalog)
    by_id = {item["id"]: item for item in catalog["stickers"]}
    assert len(selected) == len(set(selected)) == len(by_id)
    assert set(selected) == set(by_id)
    assert supplementary == {item["id"] for item in by_id.values() if item["character_id"] is None}
    assert len(supplementary) == 5
    assert selected[0] in supplementary
    assert [by_id[item]["character_id"].split(".")[0] for item in selected[1:3]] == ["mygo", "mujica"]
    assert len(catalog["characters"]) == 10
    assert catalog == original


def test_previous_catalog_without_supplementary_still_selects_both_bands():
    catalog = small_catalog()
    catalog["stickers"].pop()
    assert select_catalog_stickers(catalog) == (["mygo.test", "mujica.test"], set())


@pytest.mark.parametrize("sticker_id", [None, 123, "", " ", " leading", "trailing ", "x" * 81, "mygo.test"])
def test_invalid_or_duplicate_ids_are_rejected(sticker_id):
    catalog = small_catalog()
    catalog["stickers"][-1]["id"] = sticker_id
    with pytest.raises(ProbeError, match="^invalid_sticker_catalog_id$"):
        select_catalog_stickers(catalog)


@pytest.mark.parametrize("character", ["mygo.unknown", "mujica.unknown", "supplementary.mana", "", False, []])
def test_unknown_or_malformed_nonnull_characters_are_rejected(character):
    catalog = small_catalog()
    catalog["stickers"][-1]["character_id"] = character
    with pytest.raises(ProbeError, match="^invalid_sticker_catalog_character$"):
        select_catalog_stickers(catalog)


@pytest.mark.parametrize("category", [None, 123, "", " \n", "类" * 41])
def test_null_character_requires_valid_supplementary_category(category):
    catalog = small_catalog()
    catalog["stickers"][-1]["source_category"] = category
    with pytest.raises(ProbeError, match="^invalid_sticker_catalog_category$"):
        select_catalog_stickers(catalog)


def test_missing_character_is_not_treated_as_explicit_null():
    catalog = small_catalog()
    del catalog["stickers"][-1]["character_id"]
    with pytest.raises(ProbeError, match="^invalid_sticker_catalog_character$"):
        select_catalog_stickers(catalog)


def test_supplementary_material_cannot_stand_in_for_a_band():
    catalog = small_catalog()
    del catalog["stickers"][1]
    with pytest.raises(ProbeError, match="^sticker_catalog_missing_one_band$"):
        select_catalog_stickers(catalog)


def test_live_probe_setup_accepts_null_material_and_keeps_real_message_author(server):
    args = argparse.Namespace(url=server.origin, clients=3, duration=5,
                              include_stickers=True, city=None, operator=None)
    probe = Probe(args)
    try:
        # Exercise the originally failing setup through real HTTP and WS only;
        # the full timed network probe remains a separate deployment check.
        probe.setup()
        assert probe.checks["two_actors_claimed_distinct_seats"] is True
        assert probe.checks["all_clients_counted_online"] is True
        assert probe.sticker_ids[0] in probe.supplementary_sticker_ids
        assert len(probe.supplementary_sticker_ids) == 5
        message = request_json(probe.people[0].client, "POST", probe.room_path + "/messages", body={
            "channel": "stage", "content_type": "sticker", "sticker_id": probe.sticker_ids[0],
            "client_message_id": f"probe-supplementary-regression-{probe.run_id}",
        })["message"]
        assert message["character_id"] == "mygo.tomori"
        assert message["member_id"] == probe.people[0].member_id
        assert message["sticker"]["character_id"] is None
        assert message["sticker_id"] == probe.sticker_ids[0]
        observed = request_json(probe.people[2].client, "GET", probe.room_path + "/messages")["messages"]
        assert next(item for item in observed if item["id"] == message["id"]) == message
    finally:
        probe.cleanup()
    assert probe.cleanup_report["all_attempted_actions_confirmed"] is True
