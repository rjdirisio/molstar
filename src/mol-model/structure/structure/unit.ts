/**
 * Copyright (c) 2017-2020 mol* contributors, licensed under MIT, See LICENSE file for more info.
 *
 * @author David Sehnal <david.sehnal@gmail.com>
 * @author Alexander Rose <alexander.rose@weirdbyte.de>
 */

import { SymmetryOperator } from '../../../mol-math/geometry/symmetry-operator';
import { Model } from '../model';
import { GridLookup3D, Lookup3D } from '../../../mol-math/geometry';
import { IntraUnitBonds, computeIntraUnitBonds } from './unit/bonds';
import { CoarseElements, CoarseSphereConformation, CoarseGaussianConformation } from '../model/properties/coarse';
import { BitFlags } from '../../../mol-util';
import { UnitRings } from './unit/rings';
import StructureElement from './element';
import { ChainIndex, ResidueIndex, ElementIndex } from '../model/indexing';
import { IntMap, SortedArray, Segmentation } from '../../../mol-data/int';
import { hash2, hashFnv32a } from '../../../mol-data/util';
import { getAtomicPolymerElements, getCoarsePolymerElements, getAtomicGapElements, getCoarseGapElements, getNucleotideElements, getProteinElements } from './util/polymer';
import { mmCIF_Schema } from '../../../mol-io/reader/cif/schema/mmcif';
import { PrincipalAxes } from '../../../mol-math/linear-algebra/matrix/principal-axes';
import { getPrincipalAxes } from './util/principal-axes';
import { Boundary, getBoundary, tryAdjustBoundary } from '../../../mol-math/geometry/boundary';
import { Mat4 } from '../../../mol-math/linear-algebra';
import { IndexPairBonds } from '../../../mol-model-formats/structure/property/bonds/index-pair';
import { ElementSetIntraBondCache } from './unit/bonds/element-set-intra-bond-cache';

/**
 * A building block of a structure that corresponds to an atomic or
 * a coarse grained representation 'conveniently grouped together'.
 */
type Unit = Unit.Atomic | Unit.Spheres | Unit.Gaussians

namespace Unit {
    export const enum Kind { Atomic, Spheres, Gaussians }

    export function isAtomic(u: Unit): u is Atomic { return u.kind === Kind.Atomic; }
    export function isCoarse(u: Unit): u is Spheres | Gaussians { return u.kind === Kind.Spheres || u.kind === Kind.Gaussians; }
    export function isSpheres(u: Unit): u is Spheres { return u.kind === Kind.Spheres; }
    export function isGaussians(u: Unit): u is Gaussians { return u.kind === Kind.Gaussians; }

    export function create<K extends Kind>(id: number, invariantId: number, chainGroupId: number, traits: Traits, kind: Kind, model: Model, operator: SymmetryOperator, elements: StructureElement.Set, props?: K extends Kind.Atomic ? AtomicProperties : CoarseProperties): Unit {
        switch (kind) {
            case Kind.Atomic: return new Atomic(id, invariantId, chainGroupId, traits, model, elements, SymmetryOperator.createMapping(operator, model.atomicConformation, void 0), AtomicProperties(props));
            case Kind.Spheres: return createCoarse(id, invariantId, chainGroupId, traits, model, Kind.Spheres, elements, SymmetryOperator.createMapping(operator, model.coarseConformation.spheres, getSphereRadiusFunc(model)), CoarseProperties(props));
            case Kind.Gaussians: return createCoarse(id, invariantId, chainGroupId, traits, model, Kind.Gaussians, elements, SymmetryOperator.createMapping(operator, model.coarseConformation.gaussians, getGaussianRadiusFunc(model)), CoarseProperties(props));
        }
    }

    /** A group of units that differ only by symmetry operators. */
    export type SymmetryGroup = {
        readonly elements: StructureElement.Set
        readonly units: ReadonlyArray<Unit>
        /** Maps unit.id to index of unit in units array */
        readonly unitIndexMap: IntMap<number>
        /** Hash based on unit.invariantId which is the same for all units in the group */
        readonly hashCode: number
        /** Hash based on all unit.id values in the group, reflecting the units transformation*/
        readonly transformHash: number
    }

    function getUnitIndexMap(units: Unit[]) {
        const unitIndexMap = IntMap.Mutable<number>();
        for (let i = 0, _i = units.length; i < _i; i++) {
            unitIndexMap.set(units[i].id, i);
        }
        return unitIndexMap;
    }

    function getTransformHash(units: Unit[]) {
        const ids: number[] = [];
        for (let i = 0, _i = units.length; i < _i; i++) {
            ids.push(units[i].id);
        }
        return hashFnv32a(ids);
    }

    export function SymmetryGroup(units: Unit[]) {
        const props: {
            unitIndexMap?: IntMap<number>
        } = {};

        return {
            elements: units[0].elements,
            units,
            get unitIndexMap () {
                if (props.unitIndexMap) return props.unitIndexMap;
                props.unitIndexMap = getUnitIndexMap(units);
                return props.unitIndexMap;
            },
            hashCode: hashUnit(units[0]),
            transformHash: getTransformHash(units)
        };
    }

    export namespace SymmetryGroup {
        export function areInvariantElementsEqual(a: SymmetryGroup, b: SymmetryGroup) {
            if (a.hashCode !== b.hashCode) return false;
            return SortedArray.areEqual(a.elements, b.elements);
        }

        export function getUnitSymmetryGroupsIndexMap(symmetryGroups: ReadonlyArray<Unit.SymmetryGroup>): IntMap<number> {
            const unitSymmetryGroupsIndexMap = IntMap.Mutable<number>();
            for (let i = 0, _i = symmetryGroups.length; i < _i; i++) {
                unitSymmetryGroupsIndexMap.set(symmetryGroups[i].units[0].invariantId, i);
            }
            return unitSymmetryGroupsIndexMap;
        }
    }

    export function conformationId (unit: Unit) {
        return Unit.isAtomic(unit) ? unit.model.atomicConformation.id : unit.model.coarseConformation.id;
    }

    export function hashUnit(u: Unit) {
        return hash2(u.invariantId, SortedArray.hashCode(u.elements));
    }

    export type Traits = BitFlags<Trait>
    export const enum Trait {
        None = 0x0,
        MultiChain = 0x1,
        Partitioned = 0x2
    }
    export namespace Traits {
        export const is: (t: Traits, f: Trait) => boolean = BitFlags.has;
        export const create: (f: Trait) => Traits = BitFlags.create;
    }

    export interface Base {
        readonly id: number,
        /** invariant ID stays the same even if the Operator/conformation changes. */
        readonly invariantId: number,
        readonly chainGroupId: number,
        readonly traits: Traits,
        readonly elements: StructureElement.Set,
        readonly model: Model,
        readonly conformation: SymmetryOperator.ArrayMapping<ElementIndex>,

        getChild(elements: StructureElement.Set): Unit,
        applyOperator(id: number, operator: SymmetryOperator, dontCompose?: boolean /* = false */): Unit,
        remapModel(model: Model): Unit,

        readonly boundary: Boundary
        readonly lookup3d: Lookup3D<StructureElement.UnitIndex>
        readonly polymerElements: SortedArray<ElementIndex>
        readonly gapElements: SortedArray<ElementIndex>
        /**
         * From mmCIF/IHM schema: `_ihm_model_representation_details.model_object_primitive`.
         */
        readonly objectPrimitive: mmCIF_Schema['ihm_model_representation_details']['model_object_primitive']['T']
    }

    interface BaseProperties {
        boundary?: Boundary
        lookup3d?: Lookup3D<StructureElement.UnitIndex>
        principalAxes?: PrincipalAxes
        polymerElements?: SortedArray<ElementIndex>
        gapElements?: SortedArray<ElementIndex>
    }


    function BaseProperties(props?: BaseProperties): BaseProperties {
        return { ...props };
    }

    function getSphereRadiusFunc(model: Model) {
        const r = model.coarseConformation.spheres.radius;
        return (i: number) => r[i];
    }

    function getGaussianRadiusFunc(model: Model) {
        // TODO: compute radius for gaussians
        return (i: number) => 0;
    }

    /**
     * A bulding block of a structure that corresponds
     * to a "natural group of atoms" (most often a "chain")
     * together with a transformation (rotation and translation)
     * that is dynamically applied to the underlying atom set.
     *
     * An atom set can be referenced by multiple different units which
     * makes construction of assemblies and spacegroups very efficient.
     */
    export class Atomic implements Base {
        readonly kind = Kind.Atomic;
        readonly objectPrimitive = 'atomistic';

        readonly id: number;
        readonly invariantId: number;
        /** Used to identify a single chain split into multiple units. */
        readonly chainGroupId: number;
        readonly traits: Traits;
        readonly elements: StructureElement.Set;
        readonly model: Model;
        readonly conformation: SymmetryOperator.ArrayMapping<ElementIndex>;

        /** Reference `residueIndex` from `model` for faster access. */
        readonly residueIndex: ArrayLike<ResidueIndex>;
        /** Reference `chainIndex` from `model` for faster access. */
        readonly chainIndex: ArrayLike<ChainIndex>;

        private props: AtomicProperties;

        getChild(elements: StructureElement.Set): Unit {
            if (elements.length === this.elements.length) return this;
            return new Atomic(this.id, this.invariantId, this.chainGroupId, this.traits, this.model, elements, this.conformation, AtomicProperties());
        }

        applyOperator(id: number, operator: SymmetryOperator, dontCompose = false): Unit {
            const op = dontCompose ? operator : SymmetryOperator.compose(this.conformation.operator, operator);
            return new Atomic(id, this.invariantId, this.chainGroupId, this.traits, this.model, this.elements, SymmetryOperator.createMapping(op, this.model.atomicConformation, this.conformation.r), this.props);
        }

        remapModel(model: Model) {
            let boundary = this.props.boundary;
            if (boundary && !Unit.isSameConformation(this, model)) {
                const { x, y, z } = model.atomicConformation;
                boundary = tryAdjustBoundary({ x, y, z, indices: this.elements }, boundary);
            }
            const props = { ...this.props, bonds: tryRemapBonds(this, this.props.bonds, model), boundary, lookup3d: undefined, principalAxes: undefined };
            const conformation = this.model.atomicConformation !== model.atomicConformation
                ? SymmetryOperator.createMapping(this.conformation.operator, model.atomicConformation)
                : this.conformation;
            return new Atomic(this.id, this.invariantId, this.chainGroupId, this.traits, model, this.elements, conformation, props);
        }

        get boundary() {
            if (this.props.boundary) return this.props.boundary;
            const { x, y, z } = this.model.atomicConformation;
            this.props.boundary = getBoundary({ x, y, z, indices: this.elements });
            return this.props.boundary;
        }

        get lookup3d() {
            if (this.props.lookup3d) return this.props.lookup3d;
            const { x, y, z } = this.model.atomicConformation;
            this.props.lookup3d = GridLookup3D({ x, y, z, indices: this.elements }, this.boundary);
            return this.props.lookup3d;
        }

        get principalAxes() {
            if (this.props.principalAxes) return this.props.principalAxes;
            this.props.principalAxes = getPrincipalAxes(this);
            return this.props.principalAxes;
        }

        get bonds() {
            if (this.props.bonds) return this.props.bonds;

            const cache = ElementSetIntraBondCache.get(this.model);
            let bonds = cache.get(this.elements);
            if (!bonds) {
                bonds = computeIntraUnitBonds(this);
                cache.set(this.elements, bonds);
            }
            this.props.bonds = bonds;
            return this.props.bonds;
        }

        get rings() {
            if (this.props.rings) return this.props.rings;
            this.props.rings = UnitRings.create(this);
            return this.props.rings;
        }

        get polymerElements() {
            if (this.props.polymerElements) return this.props.polymerElements;
            this.props.polymerElements = getAtomicPolymerElements(this);
            return this.props.polymerElements;
        }

        get gapElements() {
            if (this.props.gapElements) return this.props.gapElements;
            this.props.gapElements = getAtomicGapElements(this);
            return this.props.gapElements;
        }

        get nucleotideElements() {
            if (this.props.nucleotideElements) return this.props.nucleotideElements;
            this.props.nucleotideElements = getNucleotideElements(this);
            return this.props.nucleotideElements;
        }

        get proteinElements() {
            if (this.props.proteinElements) return this.props.proteinElements;
            this.props.proteinElements = getProteinElements(this);
            return this.props.proteinElements;
        }

        get residueCount(): number {
            if (this.props.residueCount !== undefined) return this.props.residueCount;

            let residueCount = 0;
            const residueIt = Segmentation.transientSegments(this.model.atomicHierarchy.residueAtomSegments, this.elements);
            while (residueIt.hasNext) {
                residueIt.move();
                residueCount += 1;
            }

            this.props.residueCount = residueCount;
            return this.props.residueCount!;
        }

        getResidueIndex(elementIndex: StructureElement.UnitIndex) {
            return this.residueIndex[this.elements[elementIndex]];
        }

        constructor(id: number, invariantId: number, chainGroupId: number, traits: Traits, model: Model, elements: StructureElement.Set, conformation: SymmetryOperator.ArrayMapping<ElementIndex>, props: AtomicProperties) {
            this.id = id;
            this.invariantId = invariantId;
            this.chainGroupId = chainGroupId;
            this.traits = traits;
            this.model = model;
            this.elements = elements;
            this.conformation = conformation;

            this.residueIndex = model.atomicHierarchy.residueAtomSegments.index;
            this.chainIndex = model.atomicHierarchy.chainAtomSegments.index;
            this.props = props;
        }
    }

    interface AtomicProperties extends BaseProperties {
        bonds?: IntraUnitBonds
        rings?: UnitRings
        nucleotideElements?: SortedArray<ElementIndex>
        proteinElements?: SortedArray<ElementIndex>
        residueCount?: number
    }

    function AtomicProperties(props?: AtomicProperties): AtomicProperties {
        return { ...BaseProperties(props), ...props };
    }

    class Coarse<K extends Kind.Gaussians | Kind.Spheres, C extends CoarseSphereConformation | CoarseGaussianConformation> implements Base {
        readonly kind: K;
        readonly objectPrimitive: 'sphere' | 'gaussian';

        readonly id: number;
        readonly invariantId: number;
        readonly chainGroupId: number;
        readonly traits: Traits;
        readonly elements: StructureElement.Set;
        readonly model: Model;
        readonly conformation: SymmetryOperator.ArrayMapping<ElementIndex>;

        readonly coarseElements: CoarseElements;
        readonly coarseConformation: C;

        private props: CoarseProperties;

        getChild(elements: StructureElement.Set): Unit {
            if (elements.length === this.elements.length) return this as any as Unit /** lets call this an ugly temporary hack */;
            return createCoarse(this.id, this.invariantId, this.chainGroupId, this.traits, this.model, this.kind, elements, this.conformation, CoarseProperties());
        }

        applyOperator(id: number, operator: SymmetryOperator, dontCompose = false): Unit {
            const op = dontCompose ? operator : SymmetryOperator.compose(this.conformation.operator, operator);
            const ret = createCoarse(id, this.invariantId, this.chainGroupId, this.traits, this.model, this.kind, this.elements, SymmetryOperator.createMapping(op, this.getCoarseConformation(), this.conformation.r), this.props);
            // (ret as Coarse<K, C>)._lookup3d = this._lookup3d;
            return ret;
        }

        remapModel(model: Model): Unit.Spheres | Unit.Gaussians {
            const coarseConformation = this.getCoarseConformation();
            const modelCoarseConformation = getCoarseConformation(this.kind, model);
            let boundary = this.props.boundary;
            if (boundary) {
                const { x, y, z } = modelCoarseConformation;
                boundary = tryAdjustBoundary({ x, y, z, indices: this.elements }, boundary);
            }
            const props = { ...this.props, boundary, lookup3d: undefined, principalAxes: undefined };
            const conformation = coarseConformation !== modelCoarseConformation
                ? SymmetryOperator.createMapping(this.conformation.operator, modelCoarseConformation)
                : this.conformation;
            return new Coarse(this.id, this.invariantId, this.chainGroupId, this.traits, model, this.kind, this.elements, conformation, props) as Unit.Spheres | Unit.Gaussians; // TODO get rid of casting
        }

        get boundary() {
            if (this.props.boundary) return this.props.boundary;
            // TODO: support sphere radius?
            const { x, y, z } = this.getCoarseConformation();
            this.props.boundary = getBoundary({ x, y, z, indices: this.elements });
            return this.props.boundary;
        }

        get lookup3d() {
            if (this.props.lookup3d) return this.props.lookup3d;
            // TODO: support sphere radius?
            const { x, y, z } = this.getCoarseConformation();
            this.props.lookup3d = GridLookup3D({ x, y, z, indices: this.elements }, this.boundary);
            return this.props.lookup3d;
        }

        get principalAxes() {
            if (this.props.principalAxes) return this.props.principalAxes;
            this.props.principalAxes = getPrincipalAxes(this as Unit.Spheres | Unit.Gaussians); // TODO get rid of casting
            return this.props.principalAxes;
        }

        get polymerElements() {
            if (this.props.polymerElements) return this.props.polymerElements;
            this.props.polymerElements = getCoarsePolymerElements(this as Unit.Spheres | Unit.Gaussians); // TODO get rid of casting
            return this.props.polymerElements;
        }

        get gapElements() {
            if (this.props.gapElements) return this.props.gapElements;
            this.props.gapElements = getCoarseGapElements(this as Unit.Spheres | Unit.Gaussians); // TODO get rid of casting
            return this.props.gapElements;
        }

        private getCoarseConformation() {
            return getCoarseConformation(this.kind, this.model);
        }

        constructor(id: number, invariantId: number, chainGroupId: number, traits: Traits, model: Model, kind: K, elements: StructureElement.Set, conformation: SymmetryOperator.ArrayMapping<ElementIndex>, props: CoarseProperties) {
            this.kind = kind;
            this.objectPrimitive = kind === Kind.Spheres ? 'sphere' : 'gaussian';
            this.id = id;
            this.invariantId = invariantId;
            this.chainGroupId = chainGroupId;
            this.traits = traits;
            this.model = model;
            this.elements = elements;
            this.conformation = conformation;
            this.coarseElements = kind === Kind.Spheres ? model.coarseHierarchy.spheres : model.coarseHierarchy.gaussians;
            this.coarseConformation = (kind === Kind.Spheres ? model.coarseConformation.spheres : model.coarseConformation.gaussians) as C;
            this.props = props;
        }
    }

    function getCoarseConformation(kind: Kind, model: Model) {
        return kind === Kind.Spheres ? model.coarseConformation.spheres : model.coarseConformation.gaussians;
    }

    interface CoarseProperties extends BaseProperties { }

    function CoarseProperties(props?: CoarseProperties): CoarseProperties {
        return BaseProperties(props);
    }

    function createCoarse<K extends Kind.Gaussians | Kind.Spheres>(id: number, invariantId: number, chainGroupId: number, traits: Traits, model: Model, kind: K, elements: StructureElement.Set, conformation: SymmetryOperator.ArrayMapping<ElementIndex>, props: CoarseProperties): Unit {
        return new Coarse(id, invariantId, chainGroupId, traits, model, kind, elements, conformation, props) as any as Unit /** lets call this an ugly temporary hack */;
    }

    export class Spheres extends Coarse<Kind.Spheres, CoarseSphereConformation> { }
    export class Gaussians extends Coarse<Kind.Gaussians, CoarseGaussianConformation> { }

    export function areSameChainOperatorGroup(a: Unit, b: Unit) {
        return a.chainGroupId === b.chainGroupId && a.conformation.operator.name === b.conformation.operator.name;
    }

    export function areAreConformationsEquivalent(a: Unit, b: Unit) {
        if (a.elements.length !== b.elements.length) return false;
        if (!Mat4.areEqual(a.conformation.operator.matrix, b.conformation.operator.matrix, 1e-6)) return false;

        const xs = a.elements, ys = b.elements;
        const { x: xa, y: ya, z: za } = a.conformation.coordinates;
        const { x: xb, y: yb, z: zb } = b.conformation.coordinates;

        for (let i = 0, _i = xs.length; i < _i; i++) {
            const u = xs[i], v = ys[i];
            if (xa[u] !== xb[v] || ya[u] !== yb[v] || za[u] !== zb[v]) return false;
        }

        return true;
    }

    function tryRemapBonds(a: Atomic, old: IntraUnitBonds | undefined, model: Model) {
        // TODO: should include additional checks?

        if (!old) return void 0;
        if (a.model.atomicConformation.id === model.atomicConformation.id) return old;

        const oldIndex = IndexPairBonds.Provider.get(a.model);
        if (oldIndex) {
            const newIndex = IndexPairBonds.Provider.get(model);
            // TODO: check the actual indices instead of just reference equality?
            if (!newIndex || oldIndex === newIndex) return old;
            return void 0;
        }

        if (old.props?.canRemap) {
            return old;
        }
        return isSameConformation(a, model) ? old : void 0;
    }

    export function isSameConformation(a: Atomic, model: Model) {
        const xs = a.elements;
        const { x: xa, y: ya, z: za } = a.conformation.coordinates;
        const { x: xb, y: yb, z: zb } = model.atomicConformation;

        for (let i = 0, _i = xs.length; i < _i; i++) {
            const u = xs[i];
            if (xa[u] !== xb[u] || ya[u] !== yb[u] || za[u] !== zb[u]) return false;
        }

        return true;
    }
}

export default Unit;