"""The 3D view's objects builder (scripts/map_objects.py) on made-up entities and units, as dl_midtown's entity lump and
scripts/npc_units.vdata have them: where the map places each model, which model each team's shrines and patron
stand as and at what scale, and which materials the game draws as light rather than as a surface.

    python -m pytest scripts/tests        (from frontend/; numpy, Pillow and pytest)
"""
import pytest

import map_objects as mo

# Each team's shrines and patron as dl_midtown places them (Nov 2026), with the keys the builder reads.
SHRINES = [
    {'classname': 'destroyable_building', 'teamnumber': '2', 'model': 'models/npc/shrine_amber/shrine_amber.vmdl',
     'origin': [299.0, -7535.0, 980.0], 'angles': [0.0, 175.00001525878906, 0.0], 'scales': [0.75, 0.75, 0.75], 'LaneNum': '6'},
    {'classname': 'destroyable_building', 'teamnumber': '3', 'model': 'models/npc/shrine_sapphire/shrine_sapphire.vmdl',
     'origin': [-256.0, 7536.0, 1000.0], 'angles': [0.0, 20.00000762939453, 0.0], 'scales': [0.75, 0.75, 0.75], 'LaneNum': '1'},
]
PATRONS = [
    {'classname': 'npc_boss_tier3', 'subclass_name': 'npc_boss_tier3', 'teamnumber': '2',
     'origin': [-1280.0, -8034.0, 632.0], 'angles': [0.0, 90.0, 0.0], 'scales': [1.0, 1.0, 1.0]},
    {'classname': 'npc_boss_tier3', 'subclass_name': 'alt_npc_boss_tier3', 'teamnumber': '3',
     'origin': [1280.0, 8048.0, 632.0], 'angles': [0.0, 270.0, 0.0], 'scales': [1.0, 1.0, 1.0]},
]
NPC = {
    'destroyable_building': {'m_sAmberModelName': 'models/npc/shrine_amber/shrine_amber.vmdl',
                             'm_sSapphModelName': 'models/npc/shrine_sapphire/shrine_sapphire.vmdl'},
    'npc_boss_tier3': {'m_sModelName': 'models/npc/patron_amber/patron_amber.vmdl', 'm_flPhase1BossScale': 1.0},
    'alt_npc_boss_tier3': {'m_sModelName': 'models/npc/patron_sapphire/patron_sapphire.vmdl', 'm_flPhase1BossScale': 0.8},
}


def test_shrines_and_patrons_are_placed_with_their_team_height_and_facing():
    others = [
        {'classname': 'info_super_trooper_spawn', 'BossName': 'boss', 'teamnumber': '2', 'origin': [-8192.0, -1856.0, 248.0],
         'angles': [0.0, 90.0, 0.0]},
        {'classname': 'info_super_trooper_spawn', 'BossName': 'boss', 'ReinforcementsOnly': True, 'teamnumber': '2',
         'origin': [0.0, 0.0, 0.0]},  # reinforcements: no guardian stands there
        {'classname': 'citadel_breakable_prop', 'origin': [1.0, 2.0, 3.0]},
    ]
    assert mo.spawns(SHRINES + PATRONS + others) == [
        ('guardian', 0, -8192.0, -1856.0, 248.0, 90.0),
        ('patron', 0, -1280.0, -8034.0, 632.0, 90.0),
        ('patron', 1, 1280.0, 8048.0, 632.0, 270.0),
        ('shrine', 0, 299.0, -7535.0, 980.0, pytest.approx(175.0)),
        ('shrine', 1, -256.0, 7536.0, 1000.0, pytest.approx(20.0)),
    ]


def test_what_each_entity_places():
    assert [mo.spawn_kind(v) for v in SHRINES + PATRONS] == ['shrine', 'shrine', 'patron', 'patron']
    assert mo.spawn_kind({'classname': 'npc_barrack_boss'}) == 'base_guardian'
    assert mo.spawn_kind({'classname': 'info_super_trooper_spawn'}) is None  # no boss named: not a guardian's
    assert mo.spawn_kind({}) is None


def test_each_team_has_its_own_shrine_and_patron_at_the_scale_it_stands_at():
    models = {m['name']: m for m in mo.team_models(NPC, SHRINES + PATRONS)}
    assert list(models) == ['shrine_0', 'shrine_1', 'patron_0', 'patron_1']
    assert models['shrine_0']['path'] == 'models/npc/shrine_amber/shrine_amber.vmdl'
    assert models['shrine_1']['path'] == 'models/npc/shrine_sapphire/shrine_sapphire.vmdl'
    assert models['shrine_0']['scale'] == models['shrine_1']['scale'] == 0.75
    # The Hidden King's unit is npc_boss_tier3; the Archmother's, alt_npc_boss_tier3, stands at 0.8 in her first phase.
    assert (models['patron_0']['path'], models['patron_0']['scale']) == ('models/npc/patron_amber/patron_amber.vmdl', 1.0)
    assert (models['patron_1']['path'], models['patron_1']['scale']) == ('models/npc/patron_sapphire/patron_sapphire.vmdl', 0.8)
    for m in models.values():
        assert m['skins'] == {'0': None}  # one skin: the team's own model
        assert m['name'] in mo.TARGET


def test_a_shrine_without_its_model_named_takes_its_teams_from_the_units():
    bare = [{k: v for k, v in s.items() if k != 'model'} for s in SHRINES]
    models = {m['name']: m['path'] for m in mo.team_models(NPC, bare + PATRONS)}
    assert models['shrine_1'] == 'models/npc/shrine_sapphire/shrine_sapphire.vmdl'


def test_a_map_without_a_teams_shrine_or_patron_is_refused():
    with pytest.raises(ValueError, match='patron of team 1'):
        mo.team_models(NPC, SHRINES + PATRONS[:1])


def test_light_is_left_out_but_translucent_surfaces_are_kept():
    assert mo.see_through('models/npc/shrine_sapphire/materials/shrine_sapphire_light_beams.vmat', {'F_ADDITIVE_BLEND': 1})
    assert mo.see_through('models/npc/patron_amber/material/patron_amber_light_beams.vmat', {'F_TRANSLUCENT': 1})
    assert mo.see_through('materials/tools/toolsoccluder.vmat', {})
    assert mo.see_through('models/x/glow.vmat', {'F_ADDITIVE_BLEND': 1})
    # The Archmother's robes are translucent, and the shrine's pages too: surfaces all the same.
    assert not mo.see_through('models/npc/patron_sapphire/materials/patron_sapphire_body.vmat', {'F_TRANSLUCENT': 1, 'F_SELF_ILLUM': 1})
    assert not mo.see_through('models/npc/shrine_sapphire/materials/shrine_sapphire_alpha_pages.vmat', {'F_TRANSLUCENT': 1})
    assert not mo.see_through('models/npc/shrine_amber/materials/shrine_amber_main.vmat', {'F_ADDITIVE_BLEND': 0})
