import { describe, expect, it } from 'vitest';
import { authorize, roleCombinationProblem, scopeFor, type Principal } from '../../src/authz/policy.js';

const MO = 1;
const MG = 2;

const user = (id: string, ...grants: Principal['grants']): Principal => ({ userId: id, grants });
const registrarMO = user('reg-mo', { role: 'registrar', countyId: MO });
const registrarMG = user('reg-mg', { role: 'registrar', countyId: MG });
const gisMO = user('gis-mo', { role: 'gis_officer', countyId: MO });
const processorMO = user('proc-mo', { role: 'processor', countyId: MO });
const supervisor = user('sup', { role: 'supervisor', countyId: null });
const admin = user('admin', { role: 'system_admin', countyId: null });
const auditor = user('aud', { role: 'auditor', countyId: null });
const landowner = user('owner', { role: 'landowner', countyId: null });

const underReviewMO = { countyId: MO, caseStatus: 'under_review' as const, caseType: 'first_registration' as const, contributorIds: ['gis-mo', 'proc-mo'], createdBy: 'gis-mo' };

describe('jurisdiction', () => {
  it('lets a registrar decide a case in their own county', () => {
    expect(authorize(registrarMO, 'case.decide', underReviewMO).allowed).toBe(true);
  });

  it('refuses a registrar deciding a case in another county', () => {
    const d = authorize(registrarMG, 'case.decide', underReviewMO);
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/jurisdiction/);
  });

  it('fails closed when the jurisdiction is unknown', () => {
    expect(authorize(registrarMO, 'case.decide', { ...underReviewMO, countyId: undefined }).allowed).toBe(false);
    expect(authorize(registrarMO, 'case.decide', { ...underReviewMO, countyId: null }).allowed).toBe(false);
  });

  it('gives national roles read access in every county', () => {
    expect(authorize(supervisor, 'case.view', { countyId: MG }).allowed).toBe(true);
    expect(authorize(auditor, 'parcel.view_internal', { countyId: MO }).allowed).toBe(true);
  });

  it('only counts grants for the role the action needs', () => {
    const mixed = user('mixed', { role: 'registrar', countyId: MO }, { role: 'processor', countyId: MG });
    expect(authorize(mixed, 'case.decide', { ...underReviewMO, countyId: MG, contributorIds: [] }).allowed).toBe(false);
  });

  it('reports the counties a principal can work in', () => {
    expect(scopeFor(registrarMO, 'case.view')).toEqual([MO]);
    expect(scopeFor(supervisor, 'case.view')).toBe('all');
    expect(scopeFor(admin, 'case.view')).toEqual([]);
  });
});

describe('role limits', () => {
  it('does not give administrators decision authority', () => {
    expect(authorize(admin, 'case.decide', underReviewMO).allowed).toBe(false);
    expect(authorize(admin, 'case.publish', { ...underReviewMO, caseStatus: 'approved' }).allowed).toBe(false);
    expect(authorize(admin, 'case.view', { countyId: MO }).allowed).toBe(false);
  });

  it('does not let a supervisor approve by default', () => {
    expect(authorize(supervisor, 'case.decide', underReviewMO).allowed).toBe(false);
  });

  it('lets only GIS officers import geometry', () => {
    const draft = { countyId: MO, caseStatus: 'draft' as const, caseType: 'first_registration' as const };
    expect(authorize(gisMO, 'case.import_geometry', draft).allowed).toBe(true);
    expect(authorize(processorMO, 'case.import_geometry', draft).allowed).toBe(false);
    expect(authorize(registrarMO, 'case.import_geometry', draft).allowed).toBe(false);
  });

  it('does not let a GIS officer publish or decide', () => {
    expect(authorize(gisMO, 'case.publish', { ...underReviewMO, caseStatus: 'approved', contributorIds: [] }).allowed).toBe(false);
    expect(authorize(gisMO, 'case.decide', { ...underReviewMO, contributorIds: [] }).allowed).toBe(false);
  });

  it('keeps highly sensitive documents from GIS officers, supervisors and auditors', () => {
    for (const p of [gisMO, supervisor, auditor]) {
      expect(authorize(p, 'document.view_highly_sensitive', { countyId: MO }).allowed).toBe(false);
    }
    expect(authorize(processorMO, 'document.view_highly_sensitive', { countyId: MO }).allowed).toBe(true);
  });

  it('gives landowners nothing internal', () => {
    expect(authorize(landowner, 'case.view', { countyId: MO }).allowed).toBe(false);
    expect(authorize(landowner, 'parcel.view_internal', { countyId: MO }).allowed).toBe(false);
    expect(authorize(landowner, 'landowner.view_own').allowed).toBe(true);
  });

  it('denies anonymous callers', () => {
    expect(authorize(null, 'case.view', { countyId: MO }).allowed).toBe(false);
  });
});

describe('record status', () => {
  it('blocks editing once a case is submitted', () => {
    for (const status of ['under_review', 'approved', 'published', 'rejected'] as const) {
      expect(authorize(processorMO, 'case.edit_rights', { countyId: MO, caseStatus: status }).allowed).toBe(false);
    }
    expect(authorize(processorMO, 'case.edit_rights', { countyId: MO, caseStatus: 'returned' }).allowed).toBe(true);
  });

  it('only publishes approved cases', () => {
    const ctx = { countyId: MO, contributorIds: [] };
    expect(authorize(registrarMO, 'case.publish', { ...ctx, caseStatus: 'under_review' }).allowed).toBe(false);
    expect(authorize(registrarMO, 'case.publish', { ...ctx, caseStatus: 'approved' }).allowed).toBe(true);
  });

  it('does not import geometry into transfer cases', () => {
    expect(authorize(gisMO, 'case.import_geometry', { countyId: MO, caseStatus: 'draft', caseType: 'transfer' }).allowed).toBe(false);
  });
});

describe('separation of duties', () => {
  it('stops a registrar deciding a case they contributed to', () => {
    const dual = user('dual', { role: 'processor', countyId: MO }, { role: 'registrar', countyId: MO });
    const d = authorize(dual, 'case.decide', { ...underReviewMO, contributorIds: ['dual'] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Separation of duties/);
    expect(authorize(dual, 'case.publish', { ...underReviewMO, caseStatus: 'approved', contributorIds: ['dual'] }).allowed).toBe(false);
  });

  it('fails closed when contributors are unknown', () => {
    expect(authorize(registrarMO, 'case.decide', { ...underReviewMO, contributorIds: undefined }).allowed).toBe(false);
  });

  it('lets only the creator withdraw', () => {
    const draft = { countyId: MO, caseStatus: 'draft' as const, createdBy: 'gis-mo' };
    expect(authorize(gisMO, 'case.withdraw', draft).allowed).toBe(true);
    expect(authorize(processorMO, 'case.withdraw', draft).allowed).toBe(false);
  });

  it('rejects forbidden role combinations', () => {
    expect(roleCombinationProblem(['system_admin', 'registrar'])).toMatch(/administrator/);
    expect(roleCombinationProblem(['landowner', 'processor'])).toMatch(/Landowner/);
    expect(roleCombinationProblem(['auditor', 'supervisor'])).toMatch(/Auditor/);
    expect(roleCombinationProblem(['processor', 'registrar'])).toBeNull();
  });
});
