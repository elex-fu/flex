import { describe,expect,it } from "vitest";
import { DeterministicAdapter } from "./deterministic-adapter.js";
import type { AdapterEvent,DispatchContext } from "../provider/types.js";
const context:DispatchContext={hostOwnerId:"fixture-owner",hostOwnerGeneration:1,sessionId:"fixture-session",flyxTurnId:"fixture-turn",runtimeId:"fixture-runtime",runtimeGeneration:1,attemptId:"fixture-attempt"};
describe("deterministic fixture shutdown proof",()=>{
  for(const scenario of ["slow","approval"]){
    it(`awaits the original ${scenario} run before reporting a stopped fixture`,async()=>{
      const events:AdapterEvent[]=[];
      const adapter=new DeterministicAdapter({workspace:process.cwd(),onEvent:(event)=>events.push(event)});
      let settled=false;
      const run=adapter.runTurn(context.flyxTurnId,`scenario:${scenario}`,undefined,context).then((outcome)=>{settled=true;return outcome;});
      const proof=await adapter.closeAndWait(1000);
      expect(settled).toBe(true);expect(proof).toEqual({stopped:true,treeStopped:true,records:[]});
      await expect(run).resolves.toMatchObject({status:"cancelled"});expect(events.at(-1)?.kind).toBe("turn_cancelled");
      await expect(adapter.runTurn("later-turn","scenario:text")).resolves.toMatchObject({status:"failed"});
    });
  }
});
