# code-helper-skills

面向 AI 编程助手的 **Agent Skills** 合集，遵循 [Agent Skills 规范](https://agentskills.io/specification) 与 [skills-npm 目录约定](https://github.com/antfu/skills-npm/blob/main/PROPOSAL.md)（`skills/<skill-name>/SKILL.md`）。

## Skills 目录

| Skill | 说明 |
|-------|------|
| [spa-native-app-framework](skills/spa-native-app-framework/) | Vue2/3 + React：Tab 主壳 + 子页叠层、slide 转场、鉴权路由、keep-alive |

## 安装

### Cursor / Claude（skills CLI）

```bash
npx skills add DiclZYY/code-helper --skill spa-native-app-framework
```

### 手动（个人 skills 目录）

```bash
git clone git@github.com:DiclZYY/code-helper.git
# 复制或 symlink 到 ~/.cursor/skills/
# 例：skills/spa-native-app-framework → ~/.cursor/skills/spa-native-app-framework
```

### 通过 npm 包布局（可选）

本仓库 `package.json` 的 `files` 含 `skills/`，日后若发布 npm，可配合 `skills-npm` 发现技能。

## 新增 Skill

1. 在 `skills/<skill-name>/` 下创建 `SKILL.md`
2. frontmatter 中 `name` **必须**与目录名一致
3. 详细文档放在 `references/`（可选 `scripts/`、`assets/`）
4. 更新本 README 目录表

## 规范链接

- https://agentskills.io/specification
- https://github.com/antfu/skills-npm

## License

MIT
