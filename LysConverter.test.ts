import { describe, it } from 'node:test'; // using builtin test runner
import assert from 'node:assert';
import * as THREE from 'three';
import { LysConverter } from './LysConverter';
import { SupportSettings, createDefaultSettings } from '@/supports/Settings';
import { Roots, Trunk, Branch, Brace, Knot } from '@/supports/types';

// Mock Data
const MOCK_LYS_DATA = {
    objects: {
        present: {
            byId: {
                'o15': {
                    id: 'o15',
                    center: { x: 0, y: 0, z: 10 },
                    position: { x: 0, y: 0, z: 0 },
                    scale: { x: 1, y: 1, z: 1 },
                    supportsBase: ['s1'] // Root support
                }
            }
        }
    },
    supports: {
        present: {
            byId: {
                // 1. ROOT SUPPORT
                's1': {
                    id: 's1',
                    base: { x: 0, y: 0, z: 0 }, // Floor
                    tip: { x: 0, y: 0, z: 20 },
                    settings: {
                        base: { joinDiameter: 1.2 },
                        tip: { diameter: 0.6, length: 3 }
                    },
                    parentId: []
                },
                // 2. BRANCH SUPPORT (Child of s1)
                's2': {
                    id: 's2',
                    base: { x: 0, y: 0, z: 10 }, // Mid-air (needs projection)
                    tip: { x: 10, y: 0, z: 20 },
                    settings: {
                        base: { joinDiameter: 0.8 },
                        tip: { diameter: 0.6, length: 2 }
                    },
                    parentId: ['s1'] // Linked to s1
                },
                // 3. BRACE (Connecting s1 and s2) -> This might need 2 roots to be realistic brace
                // Let's make a brace between s1 and a new root s3
                's3': {
                    id: 's3',
                    base: { x: 20, y: 0, z: 0 },
                    tip: { x: 20, y: 0, z: 20 },
                    parentId: []
                },
                's4_brace': {
                    id: 's4_brace',
                    base: { x: 0, y: 0, z: 5 }, // On s1
                    tip: { x: 20, y: 0, z: 5 }, // On s3
                    settings: {
                        base: { joinDiameter: 0.5 }
                    },
                    parentId: ['s1', 's3'] // Connected to both
                }
            }
        }
    }
};

describe('LysConverter', () => {
    it('should correctly convert Roots', () => {
        const result = LysConverter.convert(MOCK_LYS_DATA, createDefaultSettings());

        const rootTrunk = result.trunks.find(t => t.id.includes('s1') || t.segments[0].bottomJoint === undefined);
        assert.ok(rootTrunk, 'Root trunk s1 should exist');
        assert.strictEqual(result.roots.length, 2, 'Should have 2 roots (s1, s3)');
    });

    it('should correctly convert Branches (Type 1 Child)', () => {
        // This expects the converter to handle parentId logic
        const result = LysConverter.convert(MOCK_LYS_DATA, createDefaultSettings());

        // Check if s2 became a Branch
        // Note: ID generation in LysConverter uses uuidv4(), so we can't check ID directly unless we control it.
        // However, we can check result.branches length.

        // Expected: 1 Branch (s2)
        assert.strictEqual(result.branches.length, 1, 'Should have 1 branch');

        const branch = result.branches[0];
        assert.ok(branch.parentKnotId, 'Branch should have a parentKnotId');

        // Verify the Knot exists
        const knot = result.knots.find(k => k.id === branch.parentKnotId);
        assert.ok(knot, 'Parent knot should exist');

        // Verify Knot is on s1
        // We need to look up if s1's trunk has this knot. 
        // Data structure: Knots link to parentShaftId.
        // We assume s1 created a trunk.
        // Since IDs are UUIDs, this is hard to trace without the converter returning a map or using deterministic IDs.
        // But we know s1 is at x=0. Knot should be near x=0.
        assert.ok(Math.abs(knot.pos.x) < 1.0, 'Knot for s2 should be on s1 (approx x=0)');

        const hostedByKnownSegment = result.trunks.some(t => t.segments.some(seg => seg.id === knot.parentShaftId))
            || result.branches.some(b => b.segments.some(seg => seg.id === knot.parentShaftId));
        assert.ok(hostedByKnownSegment, 'Imported knot.parentShaftId should match a real segment ID for editability');
    });

    it('should honor explicit parent endpoint mapping without forcing projection to parent root side', () => {
        const BASE_SIDE_HINT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_branch_flip: {
                            id: 's_branch_flip',
                            type: 1,
                            mini: false,
                            isBaseTip: true,
                            // isBaseTip should not flip branch endpoint roles for explicit single-parent hints.
                            // base remains the attach-side candidate; tip remains the model-contact side.
                            base: { x: 0.2, y: 0, z: 16 },
                            tip: { x: 6, y: 0, z: 14 },
                            parentId: [],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.6, length: 2.0 },
                            },
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_SIDE_HINT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.branches.length, 1, 'Expected one branch from single-parent support');

        const branch = result.branches[0];
        const knot = result.knots.find(k => k.id === branch.parentKnotId);
        assert.ok(knot, 'Expected branch parent knot to exist');
        assert.ok(branch.contactCone, 'Expected branch to include contact cone');

        assert.ok(Math.abs(knot!.pos.z - 16) < 1e-6,
            'parentBaseId should map which child endpoint attaches, not force attachment down to parent root side');
        assert.ok(Math.abs(branch.contactCone!.pos.x - 6) < 1e-6, 'Branch tip should remain sourced from LYS tip endpoint');
        assert.ok(Math.abs(branch.contactCone!.pos.z - 14) < 1e-6, 'Branch tip Z should remain sourced from LYS tip endpoint');

        const hostedByTrunk = result.trunks.some(t => t.segments.some(seg => seg.id === knot!.parentShaftId));
        assert.ok(hostedByTrunk, 'Hinted knot should remain attached to a real trunk segment');
    });

    it('should preserve authored explicit base-side attach for terminal endpoint-clamped children', () => {
        const BASE_CLAMP_TERMINAL_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_child_terminal: {
                            id: 's_child_terminal',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0.20344101267939063 },
                            tip: { x: 6, y: 0, z: 8 },
                            parentId: ['s_root'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.5, length: 1.5 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_CLAMP_TERMINAL_DATA as any, createDefaultSettings());
        assert.strictEqual(result.branches.length, 1, 'Expected terminal explicit child to import as branch');

        const branch = result.branches[0];
        const knot = result.knots.find((k) => k.id === branch.parentKnotId);
        assert.ok(knot, 'Expected branch parent knot for terminal child');
        assert.ok(Math.abs(knot!.pos.z - 0.20344101267939063) < 1e-6,
            'Terminal explicit base-side attach should preserve authored base-clamp knot Z');
    });

    it('should keep leaf-like terminal base-clamped children projected to host (no floating leaf knot)', () => {
        const BASE_CLAMP_LEAFLIKE_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_child_leaflike: {
                            id: 's_child_leaflike',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0.20344101267939063 },
                            // Short support (distance ~= 2.006) with tip length=2.0 -> leaf-like shaft length <= 0.2
                            tip: { x: 0.15, y: 0, z: 2.204 },
                            parentId: ['s_root'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.5, length: 2.0 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_CLAMP_LEAFLIKE_DATA as any, createDefaultSettings());
        assert.strictEqual(result.leaves.length, 1, 'Expected leaf-like child to import as leaf');

        const leaf = result.leaves[0];
        const knot = result.knots.find((k) => k.id === leaf.parentKnotId);
        assert.ok(knot, 'Expected leaf parent knot for leaf-like terminal child');

        // Should stay projected to host (around trunk first-segment start z=2), not preserved at z~0.203.
        assert.ok(Math.abs((knot?.pos.z ?? 0) - 2) < 1e-3,
            'Leaf-like terminal base-clamped child should keep projected host knot Z to avoid floating leaf knots');
    });

    it('should preserve leaf-like terminal base-clamped authored attach when Z drift is small', () => {
        const BASE_CLAMP_LEAFLIKE_SMALL_Z_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_child_leaflike_small_z: {
                            id: 's_child_leaflike_small_z',
                            type: 1,
                            mini: false,
                            // Base-clamp with large XY delta but small Z delta to host start (~2.0)
                            base: { x: 0.9, y: 0.7, z: 1.93 },
                            // Keep support leaf-like: endpoint distance close to tip length
                            tip: { x: 1.05, y: 0.7, z: 3.93 },
                            parentId: ['s_root'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.5, length: 2.0 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_CLAMP_LEAFLIKE_SMALL_Z_DATA as any, createDefaultSettings());
        assert.strictEqual(result.leaves.length, 1, 'Expected leaf-like child to import as leaf');

        const leaf = result.leaves[0];
        const knot = result.knots.find((k) => k.id === leaf.parentKnotId);
        assert.ok(knot, 'Expected leaf parent knot for leaf-like small-Z-drift child');

        assert.ok(Math.abs((knot?.pos.z ?? 0) - 1.93) < 1e-6,
            'Leaf-like base clamp with small Z drift should preserve authored attach Z');
        assert.ok(Math.abs((knot?.pos.x ?? 0) - 0.9) < 1e-6,
            'Leaf-like base clamp with small Z drift should preserve authored attach X');
    });

    it('should not let explicit endpoint-ordering fallback override deliberate projected base clamp', () => {
        const BASE_CLAMP_ORDERING_GUARD_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_child_ordering_guard: {
                            id: 's_child_ordering_guard',
                            type: 1,
                            mini: false,
                            // Mimics s85-like case: base clamped to host start (~z=2), large delta,
                            // leaf-like geometry and tip below projected knot cause ordering sign flip.
                            base: { x: 0.9, y: 0.7, z: 0.20344101267939063 },
                            tip: { x: 1.05, y: 0.7, z: 1.2 },
                            parentId: ['s_root'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.5, length: 2.0 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_CLAMP_ORDERING_GUARD_DATA as any, createDefaultSettings());
        assert.strictEqual(result.leaves.length, 1, 'Expected ordering-guard fixture to import as leaf');

        const leaf = result.leaves[0];
        const knot = result.knots.find((k) => k.id === leaf.parentKnotId);
        assert.ok(knot, 'Expected leaf parent knot in ordering-guard fixture');

        // Must remain projected to host start, not overridden back to authored base by ordering fallback.
        assert.ok(Math.abs((knot?.pos.z ?? 0) - 2) < 1e-3,
            'Endpoint-ordering fallback should not override deliberate projected base clamp knot position');
    });

    it('should fall back to parentBaseId/parentTipId host when explicit parentId is stale', () => {
        const STALE_PARENT_ID_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_child_stale_parent: {
                            id: 's_child_stale_parent',
                            base: { x: 0.2, y: 0, z: 12 },
                            tip: { x: 6, y: 0, z: 14 },
                            parentId: ['s_missing_parent'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { diameter: 0.6, length: 2 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(STALE_PARENT_ID_DATA as any, createDefaultSettings());

        assert.strictEqual(result.branches.length, 1, 'Child with stale parentId should still import via explicit parent endpoint hints');
        const branch = result.branches[0];
        const knot = result.knots.find(k => k.id === branch.parentKnotId);
        assert.ok(knot, 'Fallback-imported child should have a parent knot');
        assert.ok(result.trunks.some(t => t.segments.some(seg => seg.id === knot!.parentShaftId)),
            'Fallback-imported child knot should attach to a real trunk segment');
    });

    it('should infer single-parent attach endpoint from endpoint normals before distance heuristic', () => {
        const NORMAL_INFERRED_ENDPOINT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_child_normal_hint: {
                            id: 's_child_normal_hint',
                            // Base endpoint is model-contact (has normal), so tip endpoint should attach to host.
                            base: { x: 0.1, y: 0, z: 4.0 },
                            tip: { x: 2.5, y: 0, z: 10.0 },
                            baseNormal: { x: 0, y: 0, z: 1 },
                            parentId: ['s_root'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.6, length: 2.0 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(NORMAL_INFERRED_ENDPOINT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.branches.length, 1, 'Expected one branch from single-parent support');

        const branch = result.branches[0];
        assert.ok(branch.contactCone, 'Expected branch to include contact cone');

        // Base endpoint has the valid normal, so it should remain the model-contact tip.
        assert.ok(Math.abs(branch.contactCone!.pos.x - 0.1) < 1e-6, 'Contact cone X should follow normal-designated tip endpoint');
        assert.ok(Math.abs(branch.contactCone!.pos.z - 4.0) < 1e-6, 'Contact cone Z should follow normal-designated tip endpoint');
    });

    it('should convert grounded single-parent supports with explicit parent hint into kickstands', () => {
        const SUPPORT_BRACE_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_support_brace: {
                            id: 's_support_brace',
                            type: 1,
                            mini: false,
                            base: { x: 6, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 5 },
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: 's_root',
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.7, length: 2.0 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(SUPPORT_BRACE_DATA as any, createDefaultSettings());

        assert.strictEqual(result.trunks.length, 1, 'Expected one root trunk host');
        assert.strictEqual(result.branches.length, 0, 'Kickstand candidate should not import as branch');
        assert.strictEqual(result.leaves.length, 0, 'Kickstand candidate should not import as leaf');
        assert.strictEqual(result.kickstands?.length ?? 0, 1, 'Expected one imported kickstand build');

        const build = result.kickstands![0];
        assert.ok(build.kickstand.segments.length >= 1, 'Kickstand should include generated segments');
        assert.strictEqual(build.hostKnot.parentShaftId.length > 0, true, 'Kickstand host knot should target a host segment id');
        assert.strictEqual(Math.abs(build.root.transform.pos.z) < 1e-6, true, 'Kickstand root should remain grounded on plate');
    });

    it('should correctly convert Braces (Type 0)', () => {
        const result = LysConverter.convert(MOCK_LYS_DATA, createDefaultSettings());

        // Expected: 1 Brace (s4_brace)
        assert.strictEqual(result.braces.length, 1, 'Should have 1 brace');

        const brace = result.braces[0];
        assert.ok(brace.startKnotId, 'Brace needs start knot');
        assert.ok(brace.endKnotId, 'Brace needs end knot');

        // Check knot positions
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Start knot exists');
        assert.ok(endKnot, 'End knot exists');

        // s4_brace connects s1 (x=0) and s3 (x=20) at z=5
        // Start knot should be near x=0, z=5
        // End knot should be near x=20, z=5

        // Order is not guaranteed, but one should be near 0, one near 20.
        const x1 = startKnot.pos.x;
        const x2 = endKnot.pos.x;

        assert.ok((Math.abs(x1) < 1 && Math.abs(x2 - 20) < 1) || (Math.abs(x1 - 20) < 1 && Math.abs(x2) < 1),
            'Brace knots should match parent positions');
    });

    it('should keep authored brace endpoint positions for inferred two-parent braces (no explicit endpoint hints)', () => {
        const BRACE_NO_HINT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root_a: {
                            id: 's_root_a',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_root_b: {
                            id: 's_root_b',
                            base: { x: 10, y: 0, z: 0 },
                            tip: { x: 10, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_brace_no_hint: {
                            id: 's_brace_no_hint',
                            type: 0,
                            base: { x: 0, y: 0, z: 20 },
                            tip: { x: 10, y: 0, z: 20 },
                            parentId: ['s_root_a', 's_root_b'],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { base: { joinDiameter: 0.5 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BRACE_NO_HINT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.braces.length, 1, 'Expected one inferred two-parent brace');

        const brace = result.braces[0];
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Brace start knot should exist');
        assert.ok(endKnot, 'Brace end knot should exist');

        const sortedByX = [startKnot!, endKnot!].sort((a, b) => a.pos.x - b.pos.x);
        assert.ok(Math.abs(sortedByX[0].pos.x - 0) < 1e-6 && Math.abs(sortedByX[0].pos.z - 20) < 1e-6,
            'First brace knot should keep authored base endpoint position (x=0,z=20)');
        assert.ok(Math.abs(sortedByX[1].pos.x - 10) < 1e-6 && Math.abs(sortedByX[1].pos.z - 20) < 1e-6,
            'Second brace knot should keep authored tip endpoint position (x=10,z=20)');
    });

    it('should keep authored brace endpoint positions when explicit parentBaseId/parentTipId are provided', () => {
        const BRACE_HINT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root_a: {
                            id: 's_root_a',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_root_b: {
                            id: 's_root_b',
                            base: { x: 10, y: 0, z: 0 },
                            tip: { x: 10, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s_brace_hint: {
                            id: 's_brace_hint',
                            type: 0,
                            base: { x: 0, y: 0, z: 7 },
                            tip: { x: 10, y: 0, z: 11 },
                            parentId: [],
                            parentBaseId: 's_root_a',
                            parentTipId: 's_root_b',
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { base: { joinDiameter: 0.5 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BRACE_HINT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.braces.length, 1, 'Expected one brace from explicit parent hints');

        const brace = result.braces[0];
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Brace start knot should exist');
        assert.ok(endKnot, 'Brace end knot should exist');

        assert.ok(Math.abs(startKnot!.pos.x - 0) < 1e-6 && Math.abs(startKnot!.pos.z - 7) < 1e-6,
            'Start knot should keep authored brace base endpoint position');
        assert.ok(Math.abs(endKnot!.pos.x - 10) < 1e-6 && Math.abs(endKnot!.pos.z - 11) < 1e-6,
            'End knot should keep authored brace tip endpoint position');
    });

    it('should resolve brace hosts from explicit parentBaseId/parentTipId when parentId list is stale', () => {
        const STALE_BRACE_PARENT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root_left: {
                            id: 's_root_left',
                            type: 1,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 4, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } },
                        },
                        s_root_right: {
                            id: 's_root_right',
                            type: 1,
                            base: { x: 20, y: 0, z: 0 },
                            tip: { x: 16, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } },
                        },
                        s_brace_stale: {
                            id: 's_brace_stale',
                            type: 0,
                            base: { x: 2.8, y: 0, z: 16 },
                            tip: { x: 17.2, y: 0, z: 16 },
                            parentId: ['s_missing_a', 's_missing_b'],
                            parentBaseId: 's_root_left',
                            parentTipId: 's_root_right',
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { base: { joinDiameter: 0.5 } },
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(STALE_BRACE_PARENT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.braces.length, 1, 'Brace should import even when parentId list is stale');

        const brace = result.braces[0];
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Expected stale-parent brace start knot to exist');
        assert.ok(endKnot, 'Expected stale-parent brace end knot to exist');

        const findSegmentById = (segmentId: string) => {
            for (const trunk of result.trunks) {
                const seg = trunk.segments.find((segment) => segment.id === segmentId);
                if (seg) return seg;
            }
            for (const branch of result.branches) {
                const seg = branch.segments.find((segment) => segment.id === segmentId);
                if (seg) return seg;
            }
            return null;
        };

        const startSeg = findSegmentById(startKnot!.parentShaftId);
        const endSeg = findSegmentById(endKnot!.parentShaftId);
        assert.ok(startSeg, 'Stale-parent brace start knot should reference a valid host segment');
        assert.ok(endSeg, 'Stale-parent brace end knot should reference a valid host segment');

        const startSegTilt = startSeg?.bottomJoint && startSeg?.topJoint
            ? Math.abs(startSeg.topJoint.pos.x - startSeg.bottomJoint.pos.x)
            : 0;
        const endSegTilt = endSeg?.bottomJoint && endSeg?.topJoint
            ? Math.abs(endSeg.topJoint.pos.x - endSeg.bottomJoint.pos.x)
            : 0;

        assert.ok(startSegTilt > 0.5 && endSegTilt > 0.5,
            'Stale-parent brace knots should resolve onto the askew host segments, not the near-vertical root stubs');
    });

    it('should resolve first two valid brace hosts from misordered parentId arrays', () => {
        const MISORDERED_BRACE_PARENT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root_left: {
                            id: 's_root_left',
                            type: 1,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 4, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } },
                        },
                        s_root_right: {
                            id: 's_root_right',
                            type: 1,
                            base: { x: 20, y: 0, z: 0 },
                            tip: { x: 16, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } },
                        },
                        s_brace_misordered: {
                            id: 's_brace_misordered',
                            type: 0,
                            base: { x: 2.8, y: 0, z: 16 },
                            tip: { x: 17.2, y: 0, z: 16 },
                            parentId: ['s_missing', 's_root_right', 's_root_left'],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { base: { joinDiameter: 0.5 } },
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MISORDERED_BRACE_PARENT_DATA as any, createDefaultSettings());
        assert.strictEqual(result.braces.length, 1, 'Brace should import by resolving the first two valid hosts in a misordered parent list');

        const brace = result.braces[0];
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);

        assert.ok(startKnot, 'Expected misordered-parent brace start knot to exist');
        assert.ok(endKnot, 'Expected misordered-parent brace end knot to exist');

        const hostedByKnownSegment = result.trunks.some(t => t.segments.some(seg => seg.id === startKnot!.parentShaftId || seg.id === endKnot!.parentShaftId))
            || result.branches.some(b => b.segments.some(seg => seg.id === startKnot!.parentShaftId || seg.id === endKnot!.parentShaftId));
        assert.ok(hostedByKnownSegment, 'Misordered-parent brace knots should resolve to real host segment IDs');

        const sortedByX = [startKnot!, endKnot!].sort((a, b) => a.pos.x - b.pos.x);
        assert.ok(Math.abs(sortedByX[0].pos.x - 2.8) < 1e-6 && Math.abs(sortedByX[1].pos.x - 17.2) < 1e-6,
            'Misordered-parent brace should keep authored endpoint mapping after host resolution');
    });

    it('should bind braces to tip-side host segments when closest projection is a far endpoint clamp', () => {
        const ENDPOINT_CLAMP_BRACE_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root_left: {
                            id: 's_root_left',
                            type: 1,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 10, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0, joinLength: 12 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_root_right: {
                            id: 's_root_right',
                            type: 1,
                            base: { x: 20, y: 0, z: 0 },
                            tip: { x: 10, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0, joinLength: 12 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_brace_endpoint_clamp: {
                            id: 's_brace_endpoint_clamp',
                            type: 0,
                            // Endpoints sit high on each host, but near each root X to trigger
                            // lower-segment endpoint-clamp ambiguity in raw closest-segment projection.
                            base: { x: 0.35, y: 0, z: 14.2 },
                            tip: { x: 19.65, y: 0, z: 14.2 },
                            parentId: ['s_root_left', 's_root_right'],
                            parentBaseId: 's_root_left',
                            parentTipId: 's_root_right',
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { base: { joinDiameter: 0.5 } },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(ENDPOINT_CLAMP_BRACE_DATA as any, createDefaultSettings());
        assert.strictEqual(result.braces.length, 1, 'Expected one brace in endpoint-clamp fixture');
        assert.strictEqual(result.trunks.length, 2, 'Expected two host trunks in endpoint-clamp fixture');

        const brace = result.braces[0];
        const startKnot = result.knots.find(k => k.id === brace.startKnotId);
        const endKnot = result.knots.find(k => k.id === brace.endKnotId);
        assert.ok(startKnot && endKnot, 'Endpoint-clamp fixture should produce both brace host knots');

        const trunksByRootX = result.trunks
            .map((trunk) => ({ trunk, root: result.roots.find((root) => root.id === trunk.rootId)! }))
            .sort((a, b) => a.root.transform.pos.x - b.root.transform.pos.x);

        assert.strictEqual(trunksByRootX.length, 2, 'Expected to map two roots to two trunks');

        const leftTrunk = trunksByRootX[0].trunk;
        const rightTrunk = trunksByRootX[1].trunk;

        assert.ok(leftTrunk.segments.length >= 2 && rightTrunk.segments.length >= 2,
            'Fixture expects host trunks to have lower and tip-side segments');

        const knotsByX = [startKnot!, endKnot!].sort((a, b) => a.pos.x - b.pos.x);
        const leftKnot = knotsByX[0];
        const rightKnot = knotsByX[1];

        const leftLowerJointZ = leftTrunk.segments[0].topJoint?.pos.z ?? -Infinity;
        const rightLowerJointZ = rightTrunk.segments[0].topJoint?.pos.z ?? -Infinity;

        assert.strictEqual(leftKnot.parentShaftId, leftTrunk.segments[1].id,
            'Left brace knot should bind to the tip-side host segment rather than lower endpoint-clamped segment');
        assert.strictEqual(rightKnot.parentShaftId, rightTrunk.segments[1].id,
            'Right brace knot should bind to the tip-side host segment rather than lower endpoint-clamped segment');

        assert.ok((leftKnot.t ?? 0) > 0.05 && (leftKnot.t ?? 0) < 0.95,
            'Left brace knot should not import as an endpoint-clamped t on the upper host segment');
        assert.ok((rightKnot.t ?? 0) > 0.05 && (rightKnot.t ?? 0) < 0.95,
            'Right brace knot should not import as an endpoint-clamped t on the upper host segment');

        assert.ok(leftKnot.pos.z > leftLowerJointZ - 1e-6,
            'Left brace knot authored position should remain above the lower host joint in endpoint-clamp fixture');
        assert.ok(rightKnot.pos.z > rightLowerJointZ - 1e-6,
            'Right brace knot authored position should remain above the lower host joint in endpoint-clamp fixture');
    });

    it('should correctly convert Leaves (Type 1 Child with negligible shaft)', () => {
        // Create a Mock Leaf: Short distance between base and tip
        // We need a deep copy of MOCK_LYS_DATA to fix the const assignment issue
        const MOCK_LEAF_DATA = JSON.parse(JSON.stringify(MOCK_LYS_DATA));

        // Add a leaf support
        // We know s1 is at 0,0,0 -> 0,0,20
        // Let's place a leaf on s1 at z=15.
        // Tip is VERY close to base.
        const leafBase = { x: 0, y: 0, z: 15 };
        const leafTip = { x: 0.1, y: 0, z: 15 }; // 0.1mm away

        MOCK_LEAF_DATA.supports.present.byId['s5_leaf'] = {
            id: 's5_leaf',
            base: leafBase,
            tip: leafTip,
            settings: {
                tip: { length: 2.0 } // Cone is 2mm long. Distance (0.1) < 2.0 -> Leaf
            },
            parentId: ['s1']
        };

        const result = LysConverter.convert(MOCK_LEAF_DATA, createDefaultSettings());

        // Expected: 1 Leaf
        assert.strictEqual(result.leaves.length, 1, 'Should have 1 leaf');

        const leaf = result.leaves[0];
        assert.ok(leaf.contactCone, 'Leaf must have contact cone');
        assert.ok(leaf.parentKnotId, 'Leaf must have parent knot');

        // Ensure no branch was created for this ID (we have s2 as a branch from original mock)
        // Original mock has 1 branch (s2). So we should still have 1 branch.
        assert.strictEqual(result.branches.length, 1, 'Should still have 1 branch (s2)');
    });

    it('should import single-parent LYS mini-supports as leaves and preserve shaft-like mini diameter', () => {
        const MINI_LEAF_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                tip: { diameter: 0.6, length: 3 },
                                base: { joinDiameter: 1.0 }
                            }
                        },
                        s_mini_leaf: {
                            id: 's_mini_leaf',
                            mini: true,
                            base: { x: 0, y: 0, z: 8 },
                            tip: { x: 4, y: 0, z: 10 },
                            parentId: ['s_root'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.9 },
                                tip: { diameter: 0.5, pointDiameter: 0.25, length: 2.0 }
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MINI_LEAF_DATA as any, createDefaultSettings());

        assert.strictEqual(result.leaves.length, 1, 'Mini support should import as a leaf');
        assert.strictEqual(result.branches.length, 0, 'Mini support should not import as a branch');

        const leaf = result.leaves[0];
        const knot = result.knots.find(k => k.id === leaf.parentKnotId);
        assert.ok(knot, 'Leaf parent knot should exist');

        // Shaft-like mini should stretch cone to knot distance (not clamped to tip length).
        assert.ok((leaf.contactCone.profile.lengthMm ?? 0) > 3.5,
            'Mini leaf cone length should stretch to reach integrated knot');

        assert.strictEqual(leaf.contactCone.profile.bodyDiameterMm, 0.9,
            'Shaft-like mini leaf body diameter should follow base.joinDiameter');
    });

    it('should map mini leaf diameters by endpoint role (tip side vs attached side)', () => {
        const BASE_TIP_LEAF_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                tip: { diameter: 0.6, length: 3 },
                                base: { joinDiameter: 1.0 }
                            }
                        },
                        s_mini_leaf_basetip: {
                            id: 's_mini_leaf_basetip',
                            mini: true,
                            isBaseTip: true,
                            base: { x: 0, y: 0, z: 8 },
                            tip: { x: 3, y: 0, z: 10 },
                            parentId: ['s_root'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.6, pointDiameter: 0.25, length: 2.0 },
                                baseTip: { diameter: 1.0, pointDiameter: 1.0, length: 2.4, isStraight: true }
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(BASE_TIP_LEAF_DATA as any, createDefaultSettings());
        assert.strictEqual(result.leaves.length, 1, 'Expected mini baseTip support to import as a leaf');

        const leaf = result.leaves[0];
        assert.strictEqual(leaf.contactCone.profile.contactDiameterMm, 0.25,
            'Leaf contact diameter should follow the source tip endpoint diameter');
        assert.strictEqual(leaf.contactCone.profile.bodyDiameterMm, 1.0,
            'Leaf body diameter should follow the attached endpoint (anchor) diameter');
    });

    it('should promote mini parents with children into host branches', () => {
        const CHILD_HOST_PROMOTION_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                tip: { diameter: 0.6, length: 2.0 },
                                base: { joinDiameter: 1.0 },
                            },
                        },
                        s_mini_parent: {
                            id: 's_mini_parent',
                            mini: true,
                            base: { x: 0, y: 0, z: 8 },
                            tip: { x: 3, y: 0, z: 10 },
                            parentId: ['s_root'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.9 },
                                tip: { diameter: 0.5, pointDiameter: 0.25, length: 2.0 },
                            },
                        },
                        s_child_of_mini: {
                            id: 's_child_of_mini',
                            mini: false,
                            base: { x: 3, y: 0, z: 10.2 },
                            tip: { x: 8, y: 0, z: 16 },
                            parentId: ['s_mini_parent'],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.45, length: 1.2 },
                            },
                        },
                    },
                },
            },
        };

        const result = LysConverter.convert(CHILD_HOST_PROMOTION_DATA as any, createDefaultSettings());

        // Mini support with descendants must remain host-capable, not collapsed into a leaf.
        assert.strictEqual(result.leaves.length, 0, 'Mini parent with children should not collapse to leaf');

        // Expect both child supports to survive as branches (mini parent host + its child).
        assert.strictEqual(result.branches.length, 2, 'Expected mini parent and child to both import as branches');
    });

    it('should preserve authored attach position for middle branches in trunk->branch->branch chains', () => {
        const NESTED_BRANCH_CHAIN_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_mid_branch: {
                            id: 's_mid_branch',
                            type: 1,
                            mini: false,
                            // Deliberately beyond parent socket range so raw authored attach would overshoot.
                            base: { x: 0, y: 0, z: 23 },
                            tip: { x: 4, y: 0, z: 25 },
                            parentId: ['s_root'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.5, length: 1.5 },
                            },
                        },
                        s_child_branch: {
                            id: 's_child_branch',
                            type: 1,
                            mini: false,
                            base: { x: 4, y: 0, z: 25.2 },
                            tip: { x: 8, y: 0, z: 30 },
                            parentId: ['s_mid_branch'],
                            parentBaseId: 's_mid_branch',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.55 },
                                tip: { diameter: 0.42, length: 1.2 },
                            },
                        },
                    }
                }
            }
        };

        const result = LysConverter.convert(NESTED_BRANCH_CHAIN_DATA as any, createDefaultSettings());
        assert.strictEqual(result.branches.length, 2, 'Expected both supports in the chain to import as branches');

        const parentBranch = result.branches.find((b) =>
            result.knots.some((k) => k.parentShaftId === b.segments[0].id)
        );
        assert.ok(parentBranch, 'Expected to find the middle branch that hosts the child branch knot');

        const parentBranchKnot = result.knots.find((k) => k.id === parentBranch!.parentKnotId);
        assert.ok(parentBranchKnot, 'Expected middle branch parent knot to exist');

        // Authored attach Z was 23; middle branch can be both child and parent and should
        // preserve authored attachment when tip-side clamp indicates Lychee cone-side placement.
        assert.ok(Math.abs(parentBranchKnot!.pos.z - 23) < 1e-6,
            'Middle branch parent knot should preserve authored attach Z for nested branch chains');
    });

    it('should suppress endpoint-clamp debug logs when attach delta is negligible', () => {
        const NEGLIGIBLE_DELTA_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_root: {
                            id: 's_root',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 20 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 1.0 },
                                tip: { diameter: 0.8, length: 2.0 },
                            },
                        },
                        s_child_near_exact: {
                            id: 's_child_near_exact',
                            type: 1,
                            mini: false,
                            base: { x: 0, y: 0, z: 18 },
                            tip: { x: 6, y: 0, z: 22 },
                            parentId: ['s_root'],
                            parentBaseId: 's_root',
                            parentTipId: null,
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: {
                                base: { joinDiameter: 0.7 },
                                tip: { diameter: 0.5, length: 1.5 },
                            },
                        },
                    }
                }
            }
        };

        const originalWarn = console.warn;
        const debugMessages: unknown[] = [];

        console.warn = (...args: unknown[]) => {
            if (args[0] === '[LysConverter][debug] endpoint-clamped attach projection') {
                debugMessages.push(args);
            }
            originalWarn(...(args as Parameters<typeof console.warn>));
        };

        try {
            LysConverter.convert(NEGLIGIBLE_DELTA_DATA as any, createDefaultSettings());
        } finally {
            console.warn = originalWarn;
        }

        assert.strictEqual(debugMessages.length, 0,
            'Endpoint-clamped debug logging should be suppressed when authoredAttachDeltaMm is negligible');
    });

    it('should group supports per owning object and apply XY placement per object', () => {
        const MULTI_OBJECT_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 12, y: 3, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        },
                        o2: {
                            id: 'o2',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: -8, y: -2, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s1: {
                            id: 's1',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 15 },
                            parentId: [],
                            objectIdTip: 'o1',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        },
                        s2: {
                            id: 's2',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 15 },
                            parentId: [],
                            objectIdTip: 'o2',
                            objectIdBase: 'o2',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MULTI_OBJECT_DATA as any, createDefaultSettings());

        assert.strictEqual(result.roots.length, 2, 'Should produce one root per object owner');

        const rootO1 = result.roots.find(r => r.modelId === 'o1');
        const rootO2 = result.roots.find(r => r.modelId === 'o2');

        assert.ok(rootO1, 'Root for object o1 should exist');
        assert.ok(rootO2, 'Root for object o2 should exist');

        assert.strictEqual(rootO1!.transform.pos.x, 12, 'o1 root should receive o1 world X placement');
        assert.strictEqual(rootO1!.transform.pos.y, 3, 'o1 root should receive o1 world Y placement');
        assert.strictEqual(rootO2!.transform.pos.x, -8, 'o2 root should receive o2 world X placement');
        assert.strictEqual(rootO2!.transform.pos.y, -2, 'o2 root should receive o2 world Y placement');
    });

    it('should prefer objectIdTip when tip/base ownership are mixed', () => {
        const MIXED_OWNERSHIP_DATA = {
            objects: {
                present: {
                    byId: {
                        o1: {
                            id: 'o1',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        },
                        o2: {
                            id: 'o2',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 20, y: 0, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_mixed: {
                            id: 's_mixed',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 12 },
                            parentId: [],
                            objectIdTip: 'o2',
                            objectIdBase: 'o1',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(MIXED_OWNERSHIP_DATA as any, createDefaultSettings());
        assert.strictEqual(result.roots.length, 1, 'Should still produce one root');
        assert.strictEqual(result.roots[0].modelId, 'o2', 'Mixed ownership should resolve to objectIdTip');
        assert.strictEqual(result.roots[0].transform.pos.x, 20, 'Result should use o2 XY placement');
    });

    it('should apply world XY placement to roots without re-applying object rotation or scale (roots are in post-transform world space)', () => {
        const STAGED_TRANSFORM_DATA = {
            objects: {
                present: {
                    byId: {
                        o_stage: {
                            id: 'o_stage',
                            // Intentionally conflicting to verify formerCenter is preferred.
                            center: { x: 100, y: 100, z: 100 },
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 5, y: 7, z: 2 },
                            rotation: { x: 0, y: 0, z: 90 },
                            scale: { x: 2, y: 2, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_stage: {
                            id: 's_stage',
                            base: { x: 1, y: 0, z: 0 },
                            tip: { x: 1, y: 0, z: 12 },
                            parentId: [],
                            objectIdTip: 'o_stage',
                            objectIdBase: 'o_stage',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(STAGED_TRANSFORM_DATA as any, createDefaultSettings());
        assert.strictEqual(result.roots.length, 1, 'Expected one generated root');

        const root = result.roots[0];

        // ROOT base is in post-scale, post-rotation world XY space in LYS.
        // Only world XY placement is added; no scale or rotation is re-applied.
        // base (1,0,0) -> floor clamp => z=0 -> apply Stage B XY (+5,+7) => (6,7,0)
        assert.strictEqual(root.transform.pos.x, 6, 'X should be authored root X plus world X placement (no rotation or scale applied)');
        assert.strictEqual(root.transform.pos.y, 7, 'Y should be authored root Y plus world Y placement (no rotation or scale applied)');
        assert.strictEqual(root.transform.pos.z, 0, 'Root base should remain floor anchored at z=0');
    });

    it('should import floating dual-normal parentless supports as sticks with no root/knot entities', () => {
        const STICK_ONLY_DATA = {
            objects: {
                present: {
                    byId: {
                        o22: {
                            id: 'o22',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 4, y: -3, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s28074: {
                            id: 's28074',
                            type: 1,
                            mini: false,
                            isBaseTip: true,
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o22',
                            objectIdBase: 'o22',
                            base: { x: -0.7796396, y: 0.140519, z: 5.5941668 },
                            tip: { x: -2.1706474, y: 4.8230286, z: 6.9173617 },
                            baseNormal: { x: -0.5277328, y: 0.6205479, z: 0.5800158 },
                            tipNormal: { x: 0.3302881, y: -0.8984873, z: -0.2891890 },
                            settings: {
                                base: { joinDiameter: 1.0 },
                                baseTip: { pointDiameter: 0.42, diameter: 1.4, length: 2.5, isStraight: true },
                                tip: { pointDiameter: 0.28, diameter: 1.0, length: 2.5 },
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(STICK_ONLY_DATA as any, createDefaultSettings());

        assert.strictEqual(result.sticks?.length ?? 0, 1, 'Expected one imported stick');
        assert.strictEqual(result.twigs?.length ?? 0, 0, 'Stick fixture should not create twigs');
        assert.strictEqual(result.roots.length, 0, 'Stick fixture should not create roots');
        assert.strictEqual(result.trunks.length, 0, 'Stick fixture should not create trunks');
        assert.strictEqual(result.branches.length, 0, 'Stick fixture should not create branches');
        assert.strictEqual(result.leaves.length, 0, 'Stick fixture should not create leaves');
        assert.strictEqual(result.braces.length, 0, 'Stick fixture should not create braces');
        assert.strictEqual(result.knots.length, 0, 'Stick fixture should not create knots');

        const stick = result.sticks![0];
        assert.ok(stick.contactConeA, 'Stick should include contact cone A');
        assert.ok(stick.contactConeB, 'Stick should include contact cone B');
        assert.strictEqual(stick.segments.length, 1, 'Stick should create one shaft segment');

        // Endpoint A maps to LYS base/baseTip settings.
        assert.strictEqual(stick.contactConeA.profile.contactDiameterMm, 0.42,
            'Stick contact cone A should use base endpoint pointDiameter');
        assert.strictEqual(stick.contactConeA.profile.bodyDiameterMm, 1.4,
            'Stick contact cone A should use base endpoint body diameter');

        // Endpoint B maps to LYS tip settings.
        assert.strictEqual(stick.contactConeB.profile.contactDiameterMm, 0.28,
            'Stick contact cone B should use tip endpoint pointDiameter');
        assert.strictEqual(stick.contactConeB.profile.bodyDiameterMm, 1.0,
            'Stick contact cone B should use tip endpoint body diameter');

        // Stage B XY placement should shift both endpoints by object position.x/y.
        assert.ok(Math.abs(stick.contactConeA.pos.x - (STICK_ONLY_DATA.supports.present.byId.s28074.base.x + 4)) < 1e-6,
            'Stick contact cone A X should include object XY placement');
        assert.ok(Math.abs(stick.contactConeA.pos.y - (STICK_ONLY_DATA.supports.present.byId.s28074.base.y - 3)) < 1e-6,
            'Stick contact cone A Y should include object XY placement');
    });

    it('should import short floating dual-normal parentless supports as twigs with no root/knot entities', () => {
        const TWIG_ONLY_DATA = {
            objects: {
                present: {
                    byId: {
                        o22: {
                            id: 'o22',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: -2, y: 6, z: 0 },
                            rotation: { x: 0, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_twig: {
                            id: 's_twig',
                            type: 1,
                            mini: true,
                            isBaseTip: true,
                            parentId: [],
                            parentBaseId: null,
                            parentTipId: null,
                            objectIdTip: 'o22',
                            objectIdBase: 'o22',
                            base: { x: 1.0, y: 2.0, z: 4.0 },
                            tip: { x: 3.2, y: 2.5, z: 4.6 },
                            baseNormal: { x: 0, y: 0, z: 1 },
                            tipNormal: { x: 0, y: 0, z: 1 },
                            settings: {
                                baseTip: { pointDiameter: 0.2, diameter: 0.6, length: 1.6, isStraight: true },
                                tip: { pointDiameter: 0.24, diameter: 0.7, length: 1.6 },
                            }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(TWIG_ONLY_DATA as any, createDefaultSettings());

        assert.strictEqual(result.twigs?.length ?? 0, 1, 'Expected one imported twig');
        assert.strictEqual(result.sticks?.length ?? 0, 0, 'Twig fixture should not create sticks');
        assert.strictEqual(result.roots.length, 0, 'Twig fixture should not create roots');
        assert.strictEqual(result.trunks.length, 0, 'Twig fixture should not create trunks');
        assert.strictEqual(result.branches.length, 0, 'Twig fixture should not create branches');
        assert.strictEqual(result.leaves.length, 0, 'Twig fixture should not create leaves');
        assert.strictEqual(result.braces.length, 0, 'Twig fixture should not create braces');
        assert.strictEqual(result.knots.length, 0, 'Twig fixture should not create knots');

        const twig = result.twigs![0];
        assert.ok(twig.contactDiskA, 'Twig should include contact disk A');
        assert.ok(twig.contactDiskB, 'Twig should include contact disk B');
        assert.strictEqual(twig.segments.length, 1, 'Twig should create one shaft segment');

        assert.strictEqual(twig.contactDiskA.contactDiameterMm, 0.2,
            'Twig contact disk A should use base endpoint pointDiameter');
        assert.strictEqual(twig.contactDiskB.contactDiameterMm, 0.24,
            'Twig contact disk B should use tip endpoint pointDiameter');

        assert.ok(Math.abs(twig.contactDiskA.pos.x - (TWIG_ONLY_DATA.supports.present.byId.s_twig.base.x - 2)) < 1e-6,
            'Twig contact disk A X should include object XY placement');
        assert.ok(Math.abs(twig.contactDiskA.pos.y - (TWIG_ONLY_DATA.supports.present.byId.s_twig.base.y + 6)) < 1e-6,
            'Twig contact disk A Y should include object XY placement');
    });

    it('should transform LYS tip normals by object rotation before solving socket axis', () => {
        const NORMAL_ROTATION_DATA = {
            objects: {
                present: {
                    byId: {
                        o_norm: {
                            id: 'o_norm',
                            formerCenter: { x: 0, y: 0, z: 0 },
                            position: { x: 0, y: 0, z: 0 },
                            rotation: { x: 90, y: 0, z: 0 },
                            scale: { x: 1, y: 1, z: 1 },
                        }
                    }
                }
            },
            supports: {
                present: {
                    byId: {
                        s_norm: {
                            id: 's_norm',
                            base: { x: 0, y: 0, z: 0 },
                            tip: { x: 0, y: 0, z: 10 },
                            tipNormal: { x: 0, y: 0, z: 1 },
                            parentId: [],
                            objectIdTip: 'o_norm',
                            objectIdBase: 'o_norm',
                            settings: { tip: { length: 3 } }
                        }
                    }
                }
            }
        };

        const result = LysConverter.convert(NORMAL_ROTATION_DATA as any, createDefaultSettings());
        assert.strictEqual(result.trunks.length, 1, 'Expected one generated trunk');

        const cone = result.trunks[0].contactCone;
        assert.ok(cone, 'Generated trunk should include a contact cone');

        // With a +90° X rotation, local +Z tip normal should align to world -Y.
        // The solver may flip sign to point toward the shaft start, so we expect +Y.
        assert.ok(cone.normal.y > 0.9, 'Cone axis should align to transformed tip normal direction (toward +Y)');
        assert.ok(Math.abs(cone.normal.z) < 0.2, 'Cone axis should no longer remain near raw +Z after rotation');
    });
});
