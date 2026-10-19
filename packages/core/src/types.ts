export const ENTITY_TYPES = [
  'person',
  'organization',
  'address',
  'postal_code',
  'email',
  'phone',
  'sin',
  'health_card',
  'card_number',
  'bank_account',
  'id_number',
  'dob',
  'date',
  'amount',
  'other',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/** Types replaced unless the reviewer turns them off. The rest are detected but opt-in. */
export const DEFAULT_ON: ReadonlySet<EntityType> = new Set<EntityType>([
  'person',
  'address',
  'postal_code',
  'email',
  'phone',
  'sin',
  'health_card',
  'card_number',
  'bank_account',
  'id_number',
  'dob',
  'other',
]);

export interface PersonParts {
  first?: string;
  middle?: string;
  last?: string;
}

/**
 * A street address, split so each piece can be swapped on its own. City,
 * province and unit are carried for context but never replaced: matching keys
 * on civic number + street name, which is what survives an AI rewording
 * "123, rue des Érables" into "123 Érables Street".
 */
export interface AddressParts {
  civic?: string;
  streetType?: string;
  particle?: string;
  streetName?: string;
  unit?: string;
  city?: string;
  province?: string;
}

export interface EntityValue {
  /** Canonical display form. */
  text: string;
  person?: PersonParts;
  address?: AddressParts;
  /** ISO date for dob/date. */
  iso?: string;
  /** Numeric value for amounts. */
  amount?: number;
}

export interface EntityAttrs {
  gender?: 'f' | 'm' | 'x';
  lang?: 'fr' | 'en';
}

/**
 * What one anonymized output wrote for a value: each fake
 * surface it wrote → the real surfaces it replaced there, in the order they
 * appear (one entry when they're all the same). Restore puts back exactly
 * these, so an output pasted back comes out as the original was written:
 * "O. Lamy" and not "M. Lamy", an OCR'd "l7 août" and not "17 août", the
 * columns of a signature line and not one space.
 */
export interface MentionLog {
  /** The output (its document id). */
  doc: string;
  map: Record<string, string[]>;
}

export interface Entity {
  id: string;
  type: EntityType;
  real: EntityValue;
  fake: EntityValue;
  attrs?: EntityAttrs;
  /** Earlier fakes that were downloaded before being edited. Restore still recognizes them. */
  aliases?: EntityValue[];
  /** Real surface forms seen in documents that the variant generator wouldn't produce ("J.-F. Tremblay"). */
  surfaces?: string[];
  /** What the anonymized outputs wrote for this value, oldest first. */
  mentions?: MentionLog[];
  enabled: boolean;
  /** Present when entities from several projects are matched at once (restore routing). */
  projectId?: string;
}

export type Direction = 'anonymize' | 'restore';

export interface Match {
  start: number;
  end: number;
  surface: string;
  replacement: string;
  entityId: string;
  type: EntityType;
  kind: string;
  /**
   * Low means the hit could belong to something else (a lone first name, a
   * last name two people share). The UI leaves low restore hits unchecked.
   */
  confidence: 'high' | 'low';
  projectId?: string;
}

/** A span found by a detector before it's merged into an entity. */
export interface Detection {
  text: string;
  type: EntityType;
  start?: number;
  end?: number;
  groupKey?: string;
  person?: PersonParts;
  address?: AddressParts;
  attrs?: EntityAttrs;
  source: 'regex' | 'ner' | 'claude' | 'known' | 'manual';
}
