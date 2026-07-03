import type { DiaryEntryRecord } from '../../generated/api';
import { generateDiaryEntry, generateShortContent } from '../../lib';
import { Stat } from './Stats';

type ContentTimelinePanelProps = {
  diaryEntries: DiaryEntryRecord[];
  clipCount: number;
  shortContent: string | null;
  onRefresh: () => void | Promise<void>;
  onShortContent: (content: string) => void;
};

export function ContentTimelinePanel({
  diaryEntries,
  clipCount,
  shortContent,
  onRefresh,
  onShortContent,
}: ContentTimelinePanelProps) {
  return (
    <article className="card">
      <div className="card-heading">
        <div>
          <p className="eyebrow">今日内容</p>
          <h3>角色输出时间线</h3>
        </div>
        <div className="actions">
          <button
            className="ghost"
            onClick={async () => {
              await generateDiaryEntry();
              await onRefresh();
            }}
          >
            生成日记
          </button>
          <button
            className="ghost"
            onClick={async () => {
              const generated = await generateShortContent();
              if (generated) {
                onShortContent(generated.content);
              }
            }}
          >
            生成短内容
          </button>
        </div>
      </div>
      <dl className="definition-list">
        <Stat label="日记条目" value={String(diaryEntries.length)} />
        <Stat label="切片候选" value={String(clipCount)} />
      </dl>
      {diaryEntries.length > 0 && (
        <div className="stack-blocks" style={{ marginTop: '0.75rem' }}>
          <div className="json-block">
            <p className="eyebrow">最新日记</p>
            <p style={{ padding: '0.5rem 0', fontSize: '0.9em' }}>{diaryEntries[0]?.content}</p>
          </div>
        </div>
      )}
      {shortContent && (
        <div className="stack-blocks" style={{ marginTop: '0.5rem' }}>
          <div className="json-block">
            <p className="eyebrow">短内容</p>
            <p style={{ padding: '0.5rem 0', fontSize: '0.9em' }}>{shortContent}</p>
          </div>
        </div>
      )}
    </article>
  );
}