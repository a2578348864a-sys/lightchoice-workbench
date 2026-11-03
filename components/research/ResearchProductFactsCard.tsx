type Citation = {
  refId: string;
  source?: string;
  capturedAt: string;
};

type ItemDimensions = {
  length: number;
  width: number;
  height?: number;
  unit: "cm" | "in";
};

type ItemWeight = {
  value: number;
  unit: "kg" | "lb" | "oz" | "g";
};

type VariationStructure = {
  outcome: "complete" | "partial" | "no_variation_with_evidence";
  completeness: "complete" | "partial" | "none";
  parentAsin: string | null;
  memberAsins: readonly string[];
  members: readonly {
    asin: string;
    options: readonly { dimensionKey: string; label: string | null; value: string }[];
  }[];
  relations: readonly { fromAsin: string; toAsin: string; relation: "parent" | "child" | "peer" }[];
  evidenceRefs: readonly Citation[];
  limitation: string | null;
};

export type ResearchProductFactCardData = {
  brand?: string | null;
  price?: number | null;
  currency?: string | null;
  rating?: number | null;
  reviewCount?: number | null;
  bsr?: number | null;
  fbaFee?: { amount: number; currency: string } | null;
  fbaFeeNature?: string;
  mainCategory?: string | null;
  itemDimensions?: ItemDimensions | null;
  itemWeight?: ItemWeight | null;
  material?: string | null;
  bulletPoints?: string[];
  sourceProof?: { source: string; evidenceId: string; capturedAt: string } | null;
  fieldEvidence?: Partial<Record<string, readonly Citation[]>>;
  conflicts?: readonly {
    field: string;
    code: "SOURCE_CONFLICT_UNRESOLVED";
    resolved: false;
    candidateSources: readonly string[];
    candidates: readonly {
      source: string;
      value: unknown;
      capturedAt: string | null;
      evidenceRefs: readonly Citation[];
    }[];
    evidenceRefs: readonly Citation[];
  }[];
  variationStructure?: VariationStructure | null;
};

function formatDimensions(value: ItemDimensions | null | undefined): string | null {
  if (!value || !Number.isFinite(value.length) || !Number.isFinite(value.width)
    || (value.height !== undefined && !Number.isFinite(value.height))) return null;
  return [value.length, value.width, value.height]
    .filter((dimension): dimension is number => dimension !== undefined)
    .join(" × ") + ` ${value.unit}`;
}

function formatWeight(value: ItemWeight | null | undefined): string | null {
  return value && Number.isFinite(value.value) ? `${value.value} ${value.unit}` : null;
}

function conflictFor(field: string, conflicts: ResearchProductFactCardData["conflicts"] = []) {
  const normalized = field.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
  return conflicts.find((conflict) => {
    const conflictField = conflict.field.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
    return conflictField === normalized || conflictField.endsWith(normalized);
  });
}

function conflictFieldLabel(field: string): string {
  const normalized = field.trim().toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (normalized.endsWith("reviewcount")) return "评价数";
  if (normalized.endsWith("itemdimensions")) return "商品本体尺寸";
  if (normalized.endsWith("itemweight")) return "商品本体重量";
  if (normalized.endsWith("brand")) return "品牌";
  if (normalized.endsWith("price")) return "标价";
  if (normalized.endsWith("rating")) return "评分";
  if (normalized.endsWith("category") || normalized.endsWith("maincategory")) return "主类目";
  if (normalized.endsWith("material")) return "材质";
  if (normalized.endsWith("bulletpoints")) return "五点特征";
  if (normalized.endsWith("variationstructure") || normalized.endsWith("variations")) return "变体结构";
  return field;
}

function formatCandidateValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return "未提供";
    return serialized.length > 500 ? `${serialized.slice(0, 500)}…` : serialized;
  } catch {
    return "无法显示此候选值";
  }
}

function Citations({ references }: { references: readonly Citation[] | undefined }) {
  const unique = new Map<string, Citation>();
  for (const reference of references ?? []) {
    if (reference.refId && reference.capturedAt && !unique.has(reference.refId)) unique.set(reference.refId, reference);
  }
  if (unique.size === 0) return null;

  return (
    <details className="mt-1 text-[12px] text-slate-500">
      <summary className="cursor-pointer select-none">证据引用（{unique.size}）</summary>
      <ul className="mt-1 space-y-1 pl-1">
        {[...unique.values()].map((reference) => (
          <li key={reference.refId} className="break-all">
            <code className="rounded bg-slate-100 px-1 py-0.5">{reference.refId}</code>
            <time className="ml-1" dateTime={reference.capturedAt}>{reference.capturedAt}</time>
          </li>
        ))}
      </ul>
    </details>
  );
}

function FactCell({
  label,
  value,
  references,
}: {
  label: string;
  value: string | null;
  references: readonly Citation[] | undefined;
}) {
  return (
    <div className="min-w-0">
      <span className="block text-[13px] text-slate-400">{label}</span>
      <span className="block break-words text-slate-700">{value || "— 未提供"}</span>
      <Citations references={references} />
    </div>
  );
}

function SourceConflictDetails({ conflicts }: { conflicts: NonNullable<ResearchProductFactCardData["conflicts"]> }) {
  if (conflicts.length === 0) return null;

  return (
    <section className="border-t border-amber-100 pt-3" aria-label="来源冲突候选">
      <h3 className="mb-2 text-xs font-semibold text-amber-800">来源冲突候选</h3>
      <ul className="space-y-3">
        {conflicts.map((conflict, conflictIndex) => (
          <li key={`${conflict.field}-${conflictIndex}`} className="rounded-md bg-amber-50/70 p-2 text-xs text-slate-700">
            <h4 className="font-medium">{conflictFieldLabel(conflict.field)} · 来源冲突尚未解决</h4>
            <p className="mt-0.5 text-[12px] text-amber-800">冲突类型：{conflict.code} · 状态：未解决</p>
            <ul className="mt-2 space-y-2">
              {conflict.candidates.map((candidate, candidateIndex) => (
                <li key={`${candidate.source}-${candidateIndex}`} className="min-w-0 border-l-2 border-amber-200 pl-2">
                  <p>来源：<span className="font-mono">{candidate.source}</span></p>
                  <p className="break-all">候选值：{formatCandidateValue(candidate.value)}</p>
                  <p>采集时间：{candidate.capturedAt ?? "未记录"}</p>
                  <Citations references={candidate.evidenceRefs} />
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function VariationEvidence({
  structure,
  references,
  conflicted,
}: {
  structure: VariationStructure | null | undefined;
  references: readonly Citation[] | undefined;
  conflicted: boolean;
}) {
  const evidenceRefs = references?.length ? references : structure?.evidenceRefs;
  if (conflicted) {
    return (
      <div>
        <p className="text-xs text-amber-700">变体结构存在来源冲突，暂不展示</p>
        <Citations references={evidenceRefs} />
      </div>
    );
  }
  if (!structure) {
    return <p className="text-xs text-slate-500">暂无已核验的变体信息</p>;
  }
  if (structure.outcome === "no_variation_with_evidence") {
    return (
      <div>
        <p className="text-xs text-slate-700">现有证据未发现变体</p>
        <Citations references={evidenceRefs} />
      </div>
    );
  }

  const completeness = structure.completeness === "complete" ? "完整" : "部分";
  return (
    <div className="space-y-1.5 text-xs text-slate-700">
      <p>已核验到{completeness}变体结构</p>
      {structure.parentAsin && <p>父体 ASIN：<span className="font-mono">{structure.parentAsin}</span></p>}
      {structure.members.length > 0 ? (
        <ul className="space-y-1">
          {structure.members.map((member) => (
            <li key={member.asin}>
              <span className="font-mono">{member.asin}</span>
              {member.options.length > 0 && (
                <span className="ml-2 text-slate-500">
                  {member.options.map((option) => `${option.label || option.dimensionKey}: ${option.value}`).join(" · ")}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : structure.memberAsins.length > 0 ? (
        <p>成员 ASIN：<span className="font-mono">{structure.memberAsins.join("、")}</span></p>
      ) : null}
      {structure.relations.length > 0 && (
        <p className="text-slate-500">
          关系：{structure.relations.map((relation) => `${relation.fromAsin} → ${relation.toAsin}`).join("；")}
        </p>
      )}
      {structure.limitation && <p className="text-amber-700">限制：{structure.limitation}</p>}
      <Citations references={evidenceRefs} />
    </div>
  );
}

export function ResearchProductFactsCard({ facts }: { facts?: ResearchProductFactCardData | null }) {
  const conflicts = facts?.conflicts ?? [];
  const brandConflict = conflictFor("brand", conflicts);
  const priceConflict = conflictFor("price", conflicts);
  const ratingConflict = conflictFor("rating", conflicts);
  const reviewCountConflict = conflictFor("reviewCount", conflicts);
  const categoryConflict = conflictFor("category", conflicts);
  const dimensionsConflict = conflictFor("itemDimensions", conflicts);
  const weightConflict = conflictFor("itemWeight", conflicts);
  const materialConflict = conflictFor("material", conflicts);
  const bulletPointsConflict = conflictFor("bulletPoints", conflicts);
  const variationConflict = conflictFor("variationStructure", conflicts);
  const variationStructure = facts?.variationStructure;
  const variationEvidenceRefs = facts?.fieldEvidence?.variationStructure;
  const formatNumber = (value: number | null | undefined) => value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value);

  return (
    <div className="min-w-0 space-y-4">
      {facts?.sourceProof && (
        <p className="text-[12px] text-slate-400">
          事实记录来源：{facts.sourceProof.source} · {facts.sourceProof.capturedAt}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-3">
        <FactCell
          label="品牌"
          value={brandConflict ? "来源冲突，暂不显示数值" : facts?.brand ?? null}
          references={brandConflict?.evidenceRefs ?? facts?.fieldEvidence?.brand}
        />
        <FactCell
          label="标价"
          value={priceConflict ? "来源冲突，暂不显示数值" : facts?.price == null ? null : `${facts.price} ${facts.currency ?? ""}`.trim()}
          references={priceConflict?.evidenceRefs ?? facts?.fieldEvidence?.price}
        />
        <FactCell
          label="评分"
          value={ratingConflict ? "来源冲突，暂不显示数值" : facts?.rating == null ? null : facts.rating.toFixed(1)}
          references={ratingConflict?.evidenceRefs ?? facts?.fieldEvidence?.rating}
        />
        <FactCell
          label="评价数"
          value={reviewCountConflict ? "来源冲突，暂不显示数值" : facts?.reviewCount == null ? null : `${formatNumber(facts.reviewCount)} 条`}
          references={reviewCountConflict?.evidenceRefs ?? facts?.fieldEvidence?.reviewCount}
        />
        <FactCell
          label="主类目"
          value={categoryConflict ? "来源冲突，暂不显示数值" : facts?.mainCategory ?? null}
          references={categoryConflict?.evidenceRefs ?? facts?.fieldEvidence?.mainCategory}
        />
        <FactCell
          label="商品本体尺寸"
          value={dimensionsConflict ? "来源冲突，暂不显示数值" : formatDimensions(facts?.itemDimensions)}
          references={dimensionsConflict?.evidenceRefs ?? facts?.fieldEvidence?.itemDimensions}
        />
        <FactCell
          label="商品本体重量"
          value={weightConflict ? "来源冲突，暂不显示数值" : formatWeight(facts?.itemWeight)}
          references={weightConflict?.evidenceRefs ?? facts?.fieldEvidence?.itemWeight}
        />
        <FactCell
          label="BSR 排名"
          value={conflictFor("bsr", conflicts) ? "来源冲突，暂不显示数值" : facts?.bsr == null ? null : String(facts.bsr)}
          references={facts?.fieldEvidence?.bsr}
        />
        <FactCell
          label={facts?.fbaFeeNature === "estimate" ? "FBA 费用（第三方估算）" : "FBA 费用"}
          value={conflictFor("fbaFee", conflicts) ? "来源冲突，暂不显示数值" : facts?.fbaFee ? `${facts.fbaFee.amount} ${facts.fbaFee.currency}` : null}
          references={facts?.fieldEvidence?.fbaFee}
        />
        <FactCell
          label="材质"
          value={materialConflict ? "来源冲突，暂不显示数值" : facts?.material ?? null}
          references={materialConflict?.evidenceRefs ?? facts?.fieldEvidence?.material}
        />
      </div>

      <SourceConflictDetails conflicts={conflicts} />

      <details className="lc-research-facts-more border-t border-slate-100 pt-3">
        <summary>更多来源信息（五点特征、变体结构）</summary>
        {bulletPointsConflict ? (
          <p className="mt-2 text-xs text-amber-700">卖点摘要存在来源冲突，暂不展示</p>
        ) : Boolean(facts?.bulletPoints?.length) && (
          <div className="mt-2 text-xs text-slate-600">
            <span className="mb-1.5 block font-semibold text-slate-700">五点特征摘要</span>
            <ul className="list-inside list-disc space-y-1">
              {facts?.bulletPoints?.slice(0, 3).map((point, index) => <li key={`${index}-${point}`} className="line-clamp-2">{point}</li>)}
            </ul>
            <Citations references={facts?.fieldEvidence?.bulletPoints} />
          </div>
        )}

        <section className="mt-3" aria-label="变体证据">
          <h3 className="mb-1.5 text-xs font-semibold text-slate-700">变体结构与来源证据</h3>
          <VariationEvidence structure={variationStructure} references={variationEvidenceRefs} conflicted={Boolean(variationConflict)} />
        </section>
      </details>
    </div>
  );
}
