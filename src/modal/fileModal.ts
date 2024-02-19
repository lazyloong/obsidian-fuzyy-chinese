import { TFile, App, WorkspaceLeaf, TAbstractFile, CachedMetadata, TextComponent } from "obsidian";
import {
    Pinyin,
    PinyinIndex as PI,
    HistoryMatchDataNode,
    MatchData as uMatchData,
    Item as uItem,
    SuggestionRenderer,
    createFile,
    incrementalUpdate,
    PinyinSuggest,
} from "@/utils";
import FuzzyChinesePinyinPlugin from "@/main";
import FuzzyModal from "./modal";

const DOCUMENT_EXTENSIONS = ["md", "canvas"];

type ItemType = "file" | "alias" | "unresolvedLink" | "link";
interface Item_<T extends ItemType> extends uItem {
    file: TFile;
    type: T;
    path: string;
    pinyinOfPath: Pinyin;
}
interface FileItem extends Item_<"file"> {}
interface AliasItem extends Item_<"alias"> {}
interface UnresolvedLinkItem extends Item_<"unresolvedLink"> {}
export interface LinkItem extends Item_<"link"> {
    link: string;
}
export type Item = FileItem | AliasItem | UnresolvedLinkItem | LinkItem;

export interface MatchData<T = Item> extends uMatchData<T> {
    usePath?: boolean;
}

export default class FuzzyFileModal extends FuzzyModal<Item> {
    plugin: FuzzyChinesePinyinPlugin;
    tags: string[] = [];
    tagInput: TagInput;
    constructor(app: App, plugin: FuzzyChinesePinyinPlugin) {
        super(app, plugin);
        this.useInput = true;
        this.index = this.plugin.addChild(new PinyinIndex(this.app, this.plugin));
        this.emptyStateText = "未发现该笔记，按下回车创建。";
        this.setPlaceholder("输入以切换或创建文件……");
        this.scope.register(null, "Enter", async (e) => {
            const modKey = e.ctrlKey || e.metaKey;
            const altKey = e.altKey;
            const shiftKey = e.shiftKey;
            if (shiftKey && this.inputEl.value == "") return;
            this.close();

            let leaf: WorkspaceLeaf;
            if (modKey && altKey) leaf = app.workspace.getLeaf("split");
            else if (modKey) leaf = app.workspace.getLeaf("tab");
            else if (altKey) leaf = getNewOrAdjacentLeaf();
            else leaf = app.workspace.getMostRecentLeaf();

            if (shiftKey) {
                let newFile = await createFile(this.inputEl.value);
                leaf.openFile(newFile);
            } else {
                let item = this.getChoosenItem();
                openItem(leaf, item);
            }
        });
        let prompt = [
            {
                command: "ctrl ↵",
                purpose: "打开到新标签页",
            },
            {
                command: "ctrl alt ↵",
                purpose: "打开到新面板",
            },
            {
                command: "alt ↵",
                purpose: "打开到其他面板",
            },
            {
                command: "shift ↵",
                purpose: "创建新文件",
            },
            {
                command: "ctrl shift ↵",
                purpose: "创建新文件到新标签页",
            },
            {
                command: "shift alt ↵",
                purpose: "创建新文件到其他面板",
            },
        ];
        if (app.plugins.plugins["obsidian-hover-editor"]) {
            prompt.push({
                command: "ctrl o",
                purpose: "打开到新浮窗",
            });
            this.scope.register(["Mod"], "o", (event: KeyboardEvent) => {
                this.close();
                let item = this.getChoosenItem();
                const newLeaf = app.plugins.plugins["obsidian-hover-editor"].spawnPopover(
                    undefined,
                    () => this.app.workspace.setActiveLeaf(newLeaf)
                );
                openItem(newLeaf, item);
            });
        }
        this.setInstructions(prompt);

        let inputContainerEl = this.modalEl.querySelector(
            ".prompt-input-container"
        ) as HTMLInputElement;
        this.tagInput = new TagInput(inputContainerEl, this.plugin);
        this.tagInput.onChange((value) => {
            if (value == "") this.tags = [];
            else this.tags = value.split(",").map((t) => t.trim());
            this.onInput();
        });
        if (this.plugin.settings.file.searchWithTag) this.tagInput.show();
    }
    onClose(): void {
        super.onClose();
        this.tags = [];
        this.tagInput.setValue("");
    }
    getEmptyInputSuggestions(): MatchData[] {
        if (this.tags.length == 0) {
            this.historyMatchData = new HistoryMatchDataNode("\0");
            let items = this.index.items;
            let lastOpenFiles: MatchData[] = this.app.workspace
                .getLastOpenFiles()
                .map((p) => items.find((q) => q.type == "file" && q.path == p))
                .filter((p) => p)
                .map((p) => ({
                    item: p,
                    score: 0,
                    range: null,
                    usePath: false,
                }));
            return lastOpenFiles;
        } else {
            return this.index.items
                .filter((item) => {
                    if (!item.file) return;
                    let tagArray = getFileTagArray(item.file);
                    return (
                        tagArray &&
                        tagArray.length != 0 &&
                        tagArray.every((tag) => this.tags.some((t) => tag.startsWith(t)))
                    );
                })
                .map((p) => ({
                    item: p,
                    score: 0,
                    range: null,
                    usePath: false,
                }));
        }
    }
    getSuggestions(query: string): MatchData[] {
        if (query == "") {
            return this.getEmptyInputSuggestions();
        }

        let matchData: MatchData[] = [],
            matchData1: MatchData[] = [] /*使用标题、别名搜索的数据*/,
            matchData2: MatchData[] = []; /*使用路径搜索的数据*/

        let node: HistoryMatchDataNode<Item> = this.historyMatchData,
            lastNode: HistoryMatchDataNode<Item>,
            index = 0,
            _f = true;
        for (let i of query) {
            if (node) {
                if (i != node.query) {
                    node.init(i);
                    _f = false;
                }
            } else {
                node = lastNode.push(i);
            }
            lastNode = node;
            node = node.next;
            if (_f) index++;
        }
        let smathCase = /[A-Z]/.test(query) && this.plugin.settings.global.autoCaseSensitivity,
            indexNode = this.historyMatchData.index(index - 1),
            toMatchData = indexNode.itemIndex.length == 0 ? this.index.items : indexNode.itemIndex;
        for (let p of toMatchData) {
            let d = p.pinyin.match(query, p, smathCase);

            if (!d) continue;
            if (d.item.type == "unresolvedLink") d.score -= 15;
            matchData1.push(d);
        }

        if (this.plugin.settings.file.usePathToSearch && matchData1.length <= 10) {
            toMatchData =
                indexNode.itemIndexByPath.length == 0
                    ? this.index.items
                    : indexNode.itemIndexByPath;
            for (let p of toMatchData.filter(
                (p) => p.type == "file" && !matchData1.map((p) => p.item.path).includes(p.path)
            )) {
                let d = <MatchData>p.pinyinOfPath.match(query, p, smathCase);
                if (d) {
                    d.usePath = true;
                    matchData2.push(d);
                }
            }
        }
        matchData = matchData1.concat(matchData2);
        matchData = matchData.sort((a, b) => b.score - a.score);
        // 记录数据以便下次匹配可以使用
        if (!lastNode) lastNode = this.historyMatchData;
        lastNode.itemIndex = matchData1.map((p) => p.item);
        lastNode.itemIndexByPath = matchData2.map((p) => p.item);
        // 去除重复的笔记
        let result = matchData.reduce((acc, cur) => {
            let index = acc.findIndex((item) => item.item.path === cur.item.path);
            if (index !== -1) {
                if (cur.score > acc[index].score) {
                    acc[index] = cur;
                }
            } else {
                acc.push(cur);
            }
            return acc;
        }, []);
        if (this.plugin.settings.file.searchWithTag && this.tags.length > 0) {
            result = result.filter((matchData) => {
                if (!matchData.item.file) return;
                let tagArray = getFileTagArray(matchData.item.file);
                return tagArray?.every((tag) => this.tags.some((t) => tag.startsWith(t)));
            });
        }
        return result;
    }

    renderSuggestion(matchData: MatchData, el: HTMLElement) {
        el.addClass("fz-item");
        let renderer = new SuggestionRenderer(el);
        if (matchData.item.file) renderer.setNote(matchData.item.path);
        if (matchData.usePath) renderer.setToHighlightEl("note");
        renderer.render(matchData);

        if (this.plugin.settings.file.showTags && matchData.item.file) {
            let tagArray = getFileTagArray(matchData.item.file);
            if (tagArray) {
                let tagEl = renderer.titleEl.createDiv({ cls: "fz-suggestion-tags" });
                tagArray.forEach((p) => tagEl.createEl("a", { cls: "tag", text: p }));
            }
        }
        let icon = { alias: "forward", link: "heading" };
        if (icon[matchData.item.type]) {
            renderer.addIcon(icon[matchData.item.type]);
            if (!this.plugin.settings.file.showPath) renderer.flairEl.style.top = "9px";
            if (renderer.noteEl) renderer.noteEl.style.width = "calc(100% - 30px)";
        } else if (matchData.item.type == "unresolvedLink") renderer.addIcon("file-plus");
    }
    async onChooseSuggestion(matchData: MatchData, evt: MouseEvent | KeyboardEvent) {
        if (this.resolve) {
            this.resolve(matchData.item);
            return;
        }
        if (matchData.score == -1 || matchData.item.type == "unresolvedLink")
            matchData.item.file = await this.getChoosenItemFile(matchData);
        let leaf: WorkspaceLeaf;
        if (evt.ctrlKey && evt.altKey) leaf = this.app.workspace.getLeaf("split");
        else if (evt.ctrlKey) leaf = this.app.workspace.getLeaf("tab");
        else if (evt.altKey) leaf = getNewOrAdjacentLeaf();
        else leaf = this.app.workspace.getMostRecentLeaf();
        openItem(leaf, matchData.item);
    }
    onNoSuggestion(): void {
        super.onNoSuggestion(<MatchData>{
            item: { type: "file", name: this.inputEl.value },
            score: -1,
            usePath: false,
        });
    }
    async getChoosenItemFile(matchData?: MatchData): Promise<TFile> {
        matchData = matchData ?? this.chooser.values[this.chooser.selectedItem];
        return matchData.score == -1 || matchData.item.type == "unresolvedLink"
            ? await createFile(matchData.item.name)
            : matchData.item.file;
    }
}

// If there is only one leaf, create a new split and return it.
// If there are two or more, return a leaf that is not the currently displayed leaf.
// It means returning another leaf but don't create a new split.
// This code is based on the work of zsviczian (https://github.com/zsviczian).
// Original code: https://github.com/zsviczian/obsidian-excalidraw-plugin.
const getNewOrAdjacentLeaf = (
    leaf: WorkspaceLeaf = app.workspace.getMostRecentLeaf()
): WorkspaceLeaf => {
    const layout = app.workspace.getLayout();
    const getLeaves = (l: any) =>
        l.children
            .filter((c: any) => c.type !== "leaf")
            .map((c: any) => getLeaves(c))
            .flat()
            .concat(l.children.filter((c: any) => c.type === "leaf").map((c: any) => c.id));

    const mainLeavesIds = getLeaves(layout.main);

    const getMainLeaf = (): WorkspaceLeaf => {
        let mainLeaf = app.workspace.getMostRecentLeaf();
        if (
            mainLeaf &&
            mainLeaf !== leaf &&
            mainLeaf.view?.containerEl.ownerDocument === document
        ) {
            return mainLeaf;
        }

        mainLeavesIds.forEach((id: any) => {
            const l = app.workspace.getLeafById(id);
            if ((leaf.parent.id == l.parent.id && mainLeaf) || !l.view?.navigation || leaf === l)
                return;
            mainLeaf = l;
        });
        let newLeaf: WorkspaceLeaf;
        if (mainLeaf.parent.id == leaf.parent.id) newLeaf = app.workspace.getLeaf("split");
        else newLeaf = app.workspace.createLeafInTabGroup(mainLeaf.parent);
        return newLeaf;
    };

    const ml = getMainLeaf();
    return ml ?? app.workspace.getLeaf(true);
};

class PinyinIndex extends PI<Item> {
    fileItems: FileItem[] = [];
    aliasItems: AliasItem[] = [];
    linkItems: LinkItem[] = [];
    unresolvedLinkItems: UnresolvedLinkItem[] = [];
    constructor(app: App, plugin: FuzzyChinesePinyinPlugin) {
        super(app, plugin);
        this.id = "file";
    }
    //@ts-ignore
    get items() {
        let items: Item[] = [];
        if (this.plugin.settings.file.showUnresolvedLink)
            items = items.concat(this.unresolvedLinkItems);
        if (true) items = items.concat(this.linkItems);
        return items.concat(this.fileItems).concat(this.aliasItems);
    }
    set items(value: Item[]) {
        for (const item of value) {
            switch (item.type) {
                case "file":
                    this.fileItems.push(item);
                    break;
                case "alias":
                    this.aliasItems.push(item);
                    break;
                case "unresolvedLink":
                    this.unresolvedLinkItems.push(item);
                    break;
                case "link":
                    this.linkItems.push(item);
                    break;
            }
        }
    }
    initIndex() {
        let files = this.app.vault.getFiles().filter((f) => this.isEffectiveFile(f));

        this.fileItems = files.map((file) => TFile2Item(file, this.plugin));

        for (let file of files) {
            if (file.extension != "md") continue;
            let [a, b] = CachedMetadata2Item(file, this.plugin, this.fileItems);
            this.aliasItems = this.aliasItems.concat(a);
            this.linkItems = this.linkItems.concat(b);
        }

        this.updateUnresolvedLinkItems();
    }
    initEvent() {
        this.registerEvent(
            this.metadataCache.on("changed", (file, _, cache) =>
                this.update("changed", file, cache)
            )
        );
        this.registerEvent(
            this.metadataCache.on("resolved", () => this.updateUnresolvedLinkItems())
        );
        this.registerEvent(
            this.vault.on("rename", (file, oldPath) => this.update("rename", file, oldPath))
        );
        this.registerEvent(this.vault.on("create", (file) => this.update("create", file)));
        this.registerEvent(this.vault.on("delete", (file) => this.update("delete", file)));
    }
    update(type: "changed", file: TAbstractFile, cache: CachedMetadata): void;
    update(type: "create", file: TAbstractFile): void;
    update(type: "rename", file: TAbstractFile, oldPath: string): void;
    update(type: "delete", file: TAbstractFile): void;
    update(type: string, file: TAbstractFile, args?: any) {
        if (!this.isEffectiveFile(file)) return;
        switch (type) {
            case "changed": {
                let [a, b] = CachedMetadata2Item(file, this.plugin, this.fileItems, args);
                this.aliasItems = this.aliasItems
                    .filter((item) => item.path != file.path)
                    .concat(a);
                this.linkItems = this.linkItems.filter((item) => item.path != file.path).concat(b);
                break;
            }
            case "create": {
                this.fileItems.push(TFile2Item(file, this.plugin));
                break;
            }
            case "rename": {
                this.fileItems = this.fileItems.filter((item) => item.path != args);
                this.fileItems.push(TFile2Item(file, this.plugin));
                let [a, b] = CachedMetadata2Item(file, this.plugin, this.aliasItems);
                this.aliasItems = this.aliasItems.filter((item) => item.path != args).concat(a);
                this.linkItems = this.linkItems.filter((item) => item.path != args).concat(b);
                break;
            }
            case "delete": {
                this.fileItems = this.fileItems.filter((item) => item.path != file.path);
                this.aliasItems = this.aliasItems.filter((item) => item.path != file.path);
                break;
            }
        }
    }
    updateUnresolvedLinkItems() {
        this.unresolvedLinkItems = incrementalUpdate(
            this.unresolvedLinkItems ?? [],
            () => {
                let unresolvedLinks = new Set<string>();
                Object.values(this.metadataCache.unresolvedLinks)
                    .map((p) => Object.keys(p))
                    .filter((p) => p.length > 0)
                    .forEach((p) => p.forEach((q) => unresolvedLinks.add(q)));
                return Array.from(unresolvedLinks);
            },
            (name) =>
                <UnresolvedLinkItem>{
                    type: "unresolvedLink",
                    name,
                    pinyin: new Pinyin(name, this.plugin),
                    path: null,
                    pinyinOfPath: null,
                    file: null,
                }
        );
    }

    isEffectiveFile(file: TAbstractFile): file is TFile {
        if (!(file instanceof TFile)) return false;

        if (this.plugin.settings.file.showAllFileTypes) return true;
        else if (DOCUMENT_EXTENSIONS.includes(file.extension)) return true;
        else if (
            this.plugin.settings.file.showAttachments &&
            this.plugin.settings.file.attachmentExtensions.includes(file.extension)
        )
            return true;
        else return false;
    }
}

function TFile2Item(file: TFile, plugin: FuzzyChinesePinyinPlugin): FileItem {
    let name = file.extension != "md" ? file.name : file.basename;
    let folderIndex = plugin.folderModal.index.items;
    let fileNamePinyin = new Pinyin(name, plugin);
    let folderPathPinyin: Pinyin;
    let pathPinyin: Pinyin;
    if (file.parent.path == "/") {
        pathPinyin = fileNamePinyin;
    } else {
        folderPathPinyin = folderIndex.find((folder) => folder.name == file.parent.path)?.pinyin;
        if (folderPathPinyin)
            pathPinyin = folderPathPinyin.concat(new Pinyin("/", plugin)).concat(fileNamePinyin);
        else pathPinyin = new Pinyin(file.parent.path + "/" + name, plugin);
    }
    return {
        type: "file",
        file: file,
        name: name,
        pinyin: fileNamePinyin,
        path: file.path,
        pinyinOfPath: pathPinyin,
    };
}

function CachedMetadata2Item(
    file: TFile,
    plugin: FuzzyChinesePinyinPlugin,
    items: Item[],
    cache?: CachedMetadata
): [AliasItem[], LinkItem[]] {
    cache = cache ?? plugin.app.metadataCache.getFileCache(file);
    let alias = cache?.frontmatter?.alias || cache?.frontmatter?.aliases;
    let linkText = cache?.frontmatter?.linkText;
    let item = items.find((item) => item.path == file.path);
    let pinyinOfPath = item?.pinyinOfPath ?? new Pinyin(file.path, plugin);
    let aliasItems: AliasItem[] = [],
        linkItems: LinkItem[] = [];
    if (alias) {
        alias = Array.isArray(alias) ? alias.map((p) => String(p)) : String(alias).split(/, ?/);
        aliasItems = alias.map((p: string) => ({
            type: "alias",
            name: p,
            pinyin: new Pinyin(p, plugin),
            path: file.path,
            pinyinOfPath: pinyinOfPath,
            file: file,
        }));
    }
    if (linkText) {
        let link = Array.isArray(linkText)
            ? linkText.map((p) => String(p))
            : String(linkText).split(/, ?/);
        linkItems = link.map((p: string) => {
            let [link, name] = p.split("|");
            name = name || link;
            // if (name[0] != "#") name = "#" + name;
            return {
                type: "link",
                name,
                pinyin: new Pinyin(name, plugin),
                path: file.path,
                pinyinOfPath: pinyinOfPath,
                file: file,
                link,
            };
        });
    }
    return [aliasItems, linkItems];
}

class TagInput extends TextComponent {
    constructor(inputEl: HTMLInputElement | HTMLTextAreaElement, plugin: FuzzyChinesePinyinPlugin) {
        super(inputEl);
        this.hide();
        this.setPlaceholder("标签");
        this.inputEl.classList.add("prompt-input");
        this.inputEl.style.width = "30%";
        this.inputEl.style.borderLeft = "2px solid var(--background-primary)";
        let tagSuggest = new PinyinSuggest(this.inputEl, plugin);
        tagSuggest.getItemFunction = (query) =>
            plugin.tagEditorSuggest.getSuggestionsByString(query);
    }
    hide() {
        this.inputEl.style.display = "none";
    }
    show() {
        this.inputEl.style.display = "block";
    }
}

function openItem(leaf: WorkspaceLeaf, item: Item) {
    if (item.type == "link") {
        leaf.openLinkText(item.file.path + "#" + item.link, "");
    } else leaf.openFile(item.file);
}

function getFileTagArray(file: TFile): string[] {
    let tags: string | Array<string> =
            app.metadataCache.getFileCache(file)?.frontmatter?.tags ||
            app.metadataCache.getFileCache(file)?.frontmatter?.tag,
        tagArray: string[];
    if (tags) {
        tagArray = Array.isArray(tags)
            ? tags
            : String(tags)
                  .split(/(, ?)| +/)
                  .filter((p) => p);
    }
    return tagArray;
}