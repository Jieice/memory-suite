/**
 * 知识库种子数据脚本
 * 
 * 功能：直接写入预设的知识内容，不依赖网络
 * 
 * 使用方法：
 *   npm run seed-knowledge
 */

import { resolve } from 'path';
import * as fs from 'fs';

// 手动加载环境变量
function loadEnv() {
  const envPath = resolve(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    content.split('\n').forEach(line => {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        const [key, ...valueParts] = line.split('=');
        if (key && valueParts.length > 0) {
          let value = valueParts.join('=').trim();
          const commentIndex = value.indexOf('#');
          if (commentIndex !== -1 && !value.startsWith('"') && !value.startsWith("'")) {
            value = value.substring(0, commentIndex).trim();
          }
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
      }
    });
  }
}

loadEnv();

import { SQLiteAdapter } from '../memory-universe/src/storage/SQLiteAdapter';
import { KnowledgeEntry, KnowledgeStore } from '../memory-universe/src/storage/KnowledgeStore';

// 预设的知识内容
const SEED_KNOWLEDGE: Partial<KnowledgeEntry>[] = [
  // 直播相关
  {
    title: '直播互动技巧',
    content: '直播互动的核心是真诚和及时。要记住观众的名字，回应他们的问题，分享有趣的故事。保持积极的态度，即使遇到冷场也要自然地聊天。可以准备一些话题，比如最近看的番、玩的游戏、吃的美食等。',
    summary: '直播互动技巧：真诚、及时、记住观众、保持积极',
    category: 'general',
    source: 'manual',
    tags: ['直播', '互动', '技巧'],
  },
  {
    title: '冷场应对方法',
    content: '直播冷场时不要慌张，可以：1. 分享最近的趣事或想法；2. 问观众问题引导互动；3. 聊聊当前的心情或状态；4. 介绍正在做的事情；5. 回顾之前聊过的有趣话题。保持自然，就像和朋友聊天一样。',
    summary: '冷场应对：分享趣事、问问题、聊心情、介绍当前活动',
    category: 'general',
    source: 'manual',
    tags: ['直播', '冷场', '应对'],
  },
  
  // 游戏相关
  {
    title: '热门游戏推荐',
    content: '最近比较火的游戏有：原神（开放世界冒险）、崩坏星穹铁道（回合制RPG）、永劫无间（动作竞技）、王者荣耀（MOBA）、和平精英（吃鸡）、明日方舟（塔防策略）、碧蓝航线（舰娘收集）等。每款游戏都有自己的特色和玩家群体。',
    summary: '热门游戏：原神、崩铁、永劫、王者、吃鸡、方舟、碧蓝',
    category: 'general',
    source: 'manual',
    tags: ['游戏', '推荐', '热门'],
  },
  {
    title: '游戏聊天话题',
    content: '和观众聊游戏可以聊：最近在玩什么、游戏里的有趣经历、喜欢的角色、攻略心得、游戏更新内容、和朋友一起玩的趣事等。游戏是很好的话题，因为很多人都有共同的游戏经历。',
    summary: '游戏话题：在玩什么、有趣经历、喜欢角色、攻略心得',
    category: 'general',
    source: 'manual',
    tags: ['游戏', '话题', '聊天'],
  },
  
  // 动漫相关
  {
    title: '热门番剧推荐',
    content: '值得一看的番剧：进击的巨人（史诗剧情）、鬼灭之刃（热血战斗）、间谍过家家（温馨搞笑）、咒术回战（现代奇幻）、我推的孩子（偶像题材）、葬送的芙莉莲（治愈冒险）、药屋少女的呢喃（古风推理）等。',
    summary: '热门番剧：巨人、鬼灭、间谍、咒术、推子、芙莉莲、药屋',
    category: 'general',
    source: 'manual',
    tags: ['动漫', '番剧', '推荐'],
  },
  {
    title: '动漫聊天话题',
    content: '聊动漫可以聊：最近在追什么番、喜欢的角色和CP、经典名场面、声优、OP/ED、漫画原作、同人创作等。动漫爱好者通常很乐意分享自己的推荐和感想。',
    summary: '动漫话题：追番、角色、名场面、声优、音乐',
    category: 'general',
    source: 'manual',
    tags: ['动漫', '话题', '聊天'],
  },
  
  // 音乐相关
  {
    title: '音乐聊天话题',
    content: '聊音乐可以聊：最近在听什么歌、喜欢的歌手/乐队、演唱会经历、音乐类型偏好、歌曲背后的故事、翻唱和原创等。音乐是很好的情感连接点，很多人都有自己的音乐故事。',
    summary: '音乐话题：在听什么、喜欢歌手、演唱会、音乐类型',
    category: 'general',
    source: 'manual',
    tags: ['音乐', '话题', '聊天'],
  },
  
  // 生活相关
  {
    title: '日常生活话题',
    content: '日常话题很容易引起共鸣：今天吃了什么、天气怎么样、最近的小确幸、工作/学习的趣事、养的宠物、喜欢的美食、周末计划等。这些话题轻松自然，适合暖场。',
    summary: '日常话题：美食、天气、小确幸、趣事、宠物、计划',
    category: 'general',
    source: 'manual',
    tags: ['生活', '日常', '话题'],
  },
  {
    title: '美食推荐话题',
    content: '聊美食是很好的话题：最近吃到的好吃的、喜欢的餐厅、自己做的菜、地方特色小吃、奶茶/咖啡推荐、深夜放毒等。美食话题容易引起互动，大家都爱分享吃的。',
    summary: '美食话题：好吃的、餐厅、自己做、小吃、奶茶',
    category: 'general',
    source: 'manual',
    tags: ['美食', '推荐', '话题'],
  },
  
  // 科技相关
  {
    title: 'AI和科技话题',
    content: 'AI和科技是热门话题：ChatGPT等大语言模型、AI绘画、虚拟主播技术、新出的手机/电脑、智能家居、科技新闻等。很多人对科技感兴趣，可以聊聊自己的看法和体验。',
    summary: 'AI科技话题：大模型、AI绘画、虚拟主播、数码产品',
    category: 'general',
    source: 'manual',
    tags: ['AI', '科技', '话题'],
  },
  
  // 虚拟主播相关
  {
    title: '虚拟主播文化',
    content: 'VTuber（虚拟主播）是使用虚拟形象进行直播的主播。起源于日本，现在全球都很流行。知名的有绊爱、Hololive、彩虹社等。VTuber的魅力在于可爱的形象、有趣的人设和真实的互动。',
    summary: 'VTuber：虚拟形象直播，起源日本，Hololive、彩虹社等',
    category: 'encyclopedia',
    source: 'manual',
    tags: ['VTuber', '虚拟主播', '文化'],
  },
  {
    title: 'B站直播文化',
    content: 'B站（哔哩哔哩）是中国最大的弹幕视频网站之一，也有直播功能。B站直播以二次元、游戏、虚拟主播为特色。弹幕文化是B站的特色，观众可以发送弹幕实时互动。',
    summary: 'B站：弹幕视频网站，直播以二次元、游戏、V为特色',
    category: 'encyclopedia',
    source: 'manual',
    tags: ['B站', '直播', '弹幕'],
  },
  
  // 情感/心理相关
  {
    title: '积极心态保持',
    content: '保持积极心态的方法：1. 关注当下，不过度担忧未来；2. 记录每天的小确幸；3. 和朋友聊天分享；4. 做自己喜欢的事；5. 适当运动和休息；6. 接受不完美的自己。心态好，一切都会好起来的。',
    summary: '积极心态：关注当下、记录小确幸、分享、做喜欢的事',
    category: 'general',
    source: 'manual',
    tags: ['心态', '积极', '心理'],
  },
  {
    title: '聊天暖场技巧',
    content: '暖场技巧：1. 主动打招呼，记住常来的观众；2. 分享自己的状态和心情；3. 问开放性问题引导互动；4. 对观众的回复给予积极反馈；5. 适时使用表情和语气词；6. 保持轻松自然的氛围。',
    summary: '暖场技巧：打招呼、分享状态、问问题、积极反馈',
    category: 'general',
    source: 'manual',
    tags: ['暖场', '技巧', '聊天'],
  },
  
  // 季节/节日相关
  {
    title: '季节话题',
    content: '季节是很好的话题：春天聊赏花、踏青；夏天聊避暑、冰饮、游泳；秋天聊秋游、美食、落叶；冬天聊保暖、火锅、雪景。季节变化带来的生活变化很容易引起共鸣。',
    summary: '季节话题：春赏花、夏避暑、秋美食、冬保暖',
    category: 'general',
    source: 'manual',
    tags: ['季节', '话题', '生活'],
  },
];

async function seedKnowledge() {
  console.log('🌱 知识库种子数据脚本启动\n');
  console.log('=' .repeat(60));
  
  // 初始化数据库
  const projectRoot = resolve(__dirname, '..');
  const dbPath = process.env.SQLITE_DB_PATH || resolve(projectRoot, 'data', 'memory_universe.db');
  
  console.log(`📂 数据库路径: ${dbPath}`);
  
  const sqliteAdapter = new SQLiteAdapter(dbPath);
  await sqliteAdapter.initialize();
  
  const store = sqliteAdapter.knowledgeStore;
  
  // 写入种子数据
  console.log(`\n📝 写入 ${SEED_KNOWLEDGE.length} 条种子数据...\n`);
  
  let successCount = 0;
  let skipCount = 0;
  
  for (const seed of SEED_KNOWLEDGE) {
    try {
      // 生成完整的 entry
      const entry: KnowledgeEntry = {
        id: KnowledgeStore.generateId(seed.source || 'manual', seed.title || '', seed.title || ''),
        title: seed.title || '',
        content: seed.content || '',
        summary: seed.summary || '',
        category: seed.category || 'general',
        source: seed.source || 'manual',
        fetchedAt: Date.now(),
        updatedAt: Date.now(),
        reliability: 0.9, // 手动添加的内容可靠性高
        relevance: 0.8,
        useCount: 0,
        tags: seed.tags || [],
        relatedTopics: [],
      };
      
      // 检查是否已存在
      const existing = await store.get(entry.id);
      if (existing) {
        console.log(`   ⏭️ 跳过（已存在）: ${seed.title}`);
        skipCount++;
        continue;
      }
      
      await store.save(entry, true); // immediate=true 强制立即写入，不使用缓冲
      console.log(`   ✅ 已添加: ${seed.title}`);
      successCount++;
    } catch (error: any) {
      console.log(`   ❌ 失败: ${seed.title} - ${error.message}`);
    }
  }
  
  // 获取统计
  const stats = await store.getStats();
  
  console.log('\n' + '=' .repeat(60));
  console.log('\n🎉 种子数据写入完成！\n');
  console.log(`📈 统计信息:`);
  console.log(`   - 新增: ${successCount} 条`);
  console.log(`   - 跳过: ${skipCount} 条`);
  console.log(`   - 知识库总条目: ${stats.totalCount}`);
  console.log('\n' + '=' .repeat(60));
  
  // 停止写入缓冲定时器并关闭数据库
  store.stopFlushTimer();
  await sqliteAdapter.close();
  
  console.log('\n✅ 完成！现在 AI 可以使用这些知识进行主动发言了。');
  
  // 强制退出，避免定时器残留
  process.exit(0);
}

// 运行
seedKnowledge().catch(error => {
  console.error('\n❌ 失败:', error);
  process.exit(1);
});
