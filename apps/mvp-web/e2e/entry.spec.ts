import { expect,test } from "@playwright/test";
import { readFile,writeFile,realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { ClientDraft,HostProfile,PendingCommand } from "@flyx/client-core";
import { clientRecords,pair,sendPrompt,storedCommands,waitForIdle } from "./helpers";

test.describe("actual Web entry durability and bounded reads",()=>{
  test("drafts survive reload and a newer edit survives the original persisted command",async({page})=>{
    await pair(page);
    const input=page.locator("textarea");await input.fill("scenario:slow");
    await expect.poll(async()=> (await clientRecords<ClientDraft>(page,"drafts"))[0]?.text).toBe("scenario:slow");
    const original=(await clientRecords<ClientDraft>(page,"drafts"))[0]!;
    await page.reload();await expect(input).toHaveValue("scenario:slow");
    const turn=await sendPrompt(page,"scenario:slow");await expect(input).toHaveValue("");
    const command=(await storedCommands(page)).find((item)=>item.commandId===turn.commandId)!;
    expect((command.payload as {clientMessageId?:string}).clientMessageId).toBe(original.clientMessageId);
    await input.fill("new edit while original Turn runs");
    await expect.poll(async()=> (await clientRecords<ClientDraft>(page,"drafts"))[0]?.text).toBe("new edit while original Turn runs");
    const newer=(await clientRecords<ClientDraft>(page,"drafts"))[0]!;expect(newer.clientMessageId).not.toBe(original.clientMessageId);
    await waitForIdle(page,turn);await expect(input).toHaveValue(newer.text);
    await page.reload();await expect(input).toHaveValue(newer.text);
    await page.screenshot({path:test.info().outputPath("durable-draft.png"),fullPage:true});
  });

  test("a real IndexedDB draft-write failure retains input and sends no command",async({page})=>{
    await pair(page);const before=(await storedCommands(page)).length;
    await page.evaluate(()=>{
      const original=IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put=function(value:unknown,key?:IDBValidKey){if(this.name==="drafts")throw new DOMException("fixture draft write failed","QuotaExceededError");return key===undefined?original.call(this,value):original.call(this,value,key);};
    });
    await page.locator("textarea").fill("must remain editable after storage failure");
    await page.getByRole("button",{name:"发送任务",exact:true}).click();
    await expect(page.locator("textarea")).toHaveValue("must remain editable after storage failure");
    await expect(page.getByRole("alert").filter({hasText:/storage transaction failed/}).first()).toBeVisible();
    expect((await storedCommands(page)).length).toBe(before);
    await page.screenshot({path:test.info().outputPath("storage-failure.png"),fullPage:true});
  });

  test("a large canonical Timeline body is explicitly loaded through verified content reads",async({page})=>{
    await pair(page);const turn=await sendPrompt(page,"scenario:large-body");await waitForIdle(page,turn);
    const item=page.locator("article.assistant_message").filter({has:page.getByRole("button",{name:"按需加载内容",exact:true})}).last();
    await expect(item).toBeVisible();await expect(item).not.toContainText("bounded browser body end");
    await item.getByRole("button",{name:"按需加载内容",exact:true}).click();
    await expect(page.locator("article.assistant_message").last()).toContainText("bounded browser body end");
    await expect(page.locator("article.assistant_message").last().getByRole("button",{name:"按需加载内容",exact:true})).toHaveCount(0);
    await page.screenshot({path:test.info().outputPath("loaded-timeline-body.png")});
  });

  test("large Git Diff remains a preview until its actual bounded reference is read",async({page})=>{
    await pair(page);
    const workspace=process.env.FLYX_WORKSPACE;if(!workspace||!workspace.includes("flyx-browser-fixture-"))throw new Error("isolated fixture workspace required");
    const file=resolve(await realpath(workspace),"README.md");const original=await readFile(file,"utf8");
    try{
      await writeFile(file,original+"\n"+"bounded-diff-fixture-line\n".repeat(12_000)+"bounded browser diff end\n");
      await page.getByRole("button",{name:"查看 Diff",exact:true}).click();
      const diff=page.locator("section.diff");await expect(diff).toContainText("当前为预览");await expect(diff).not.toContainText("bounded browser diff end");
      await diff.getByRole("button",{name:/读取 Diff 内容/}).click();
      await expect(diff).toContainText("bounded browser diff end");await expect(diff).not.toContainText("当前为预览");
      await page.screenshot({path:test.info().outputPath("loaded-diff-reference.png")});
    }finally{await writeFile(file,original);}
  });

  test("unknown saved command offers read-only receipt review and is never resent",async({page})=>{
    await pair(page);const [profile]=await clientRecords<HostProfile>(page,"profiles");if(!profile)throw new Error("paired profile required");
    const command:PendingCommand={commandId:crypto.randomUUID(),hostId:profile.hostId,method:"session.startTurn",payload:{prompt:"must never be replayed"},payloadHash:"fixture-unknown-hash",createdAt:new Date().toISOString(),state:"receipt_unknown",dispatchState:"possibly_dispatched",outcomeUnknown:true};
    await page.evaluate((command)=>new Promise<void>((resolve,reject)=>{
      const open=indexedDB.open("flyx-client-v1");open.onerror=()=>reject(open.error);open.onsuccess=()=>{const db=open.result;const tx=db.transaction("commands","readwrite");tx.objectStore("commands").put(command,command.commandId);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>{db.close();reject(tx.error);};};
    }),command);
    let mutations=0;
    page.on("websocket",(socket)=>socket.on("framesent",(event)=>{try{const frame=JSON.parse(String(event.payload));if(frame.method==="session.startTurn")mutations++;}catch{/* non-JSON frame */}}));
    await page.reload();const review=page.getByRole("region",{name:"命令回执核对"});await expect(review).toContainText("执行结果未知");
    await expect(review.getByRole("button",{name:"发送已保存命令",exact:true})).toHaveCount(0);
    await review.getByRole("button",{name:"核对 Host 回执",exact:true}).click();await expect(review).toContainText("执行结果未知");
    await expect(page.getByRole("button",{name:"发送任务",exact:true})).toBeDisabled();
    expect(mutations).toBe(0);expect((await clientRecords<PendingCommand>(page,"commands")).find((item)=>item.commandId===command.commandId)?.dispatchState).toBe("possibly_dispatched");
    await page.screenshot({path:test.info().outputPath("unknown-receipt-review.png"),fullPage:true});
  });
});
