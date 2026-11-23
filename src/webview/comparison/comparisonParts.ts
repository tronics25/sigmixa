import type { ComparisonGraphDefinition } from '../../core/project/comparison';
import type { ComparisonCard, GraphHost } from './graphCard';

/** A kind of view only the HTML report has: its entry in **Add view**, and what a new one shows. */
export interface MoreView { readonly kind: NonNullable<ComparisonGraphDefinition['kind']>; readonly label: string; readonly icon: string; settings(): Partial<ComparisonGraphDefinition> }

/**
 * For the HTML report, which has kinds of view of its own: it lists them in **Add view** (`moreViews`) and makes their
 * cards (`makeCard`). The report sets these before the comparison page starts.
 */
export const comparisonParts: { moreViews: MoreView[]; makeCard?: (definition: ComparisonGraphDefinition, host: GraphHost, list: HTMLElement, optionsHost: HTMLElement) => ComparisonCard | undefined } = { moreViews: [] };
