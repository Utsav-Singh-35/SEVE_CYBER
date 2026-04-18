#!/usr/bin/env python3
"""
LLM Service - Python-based local AI inference using llama.cpp
Communicates with Electron via JSON stdin/stdout
"""
import sys
import json
import os
from pathlib import Path
from llama_cpp import Llama

# Global model instance
llm = None
model_path = None

def load_model(path):
    """Load the GGUF model"""
    global llm, model_path
    
    if llm is not None and model_path == path:
        return {"success": True, "message": "Model already loaded"}
    
    try:
        print(f"[LLM] Loading model from: {path}", file=sys.stderr)
        llm = Llama(
            model_path=path,
            n_ctx=2048,
            n_batch=512,
            n_threads=4,
            verbose=False
        )
        model_path = path
        print(f"[LLM] Model loaded successfully", file=sys.stderr)
        return {"success": True, "message": "Model loaded"}
    except Exception as e:
        print(f"[LLM] Error loading model: {e}", file=sys.stderr)
        return {"success": False, "error": str(e)}

def generate(prompt, max_tokens=500, temperature=0.7, top_p=0.9, top_k=40):
    """Generate text from prompt"""
    global llm
    
    if llm is None:
        return {"success": False, "error": "Model not loaded"}
    
    try:
        print(f"[LLM] Generating response (max_tokens={max_tokens})...", file=sys.stderr)
        
        output = llm(
            prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            echo=False,
            stop=["</s>", "\n\n\n", "User:", "Question:", "\n\nQuestion", "\n\nUser"],
            repeat_penalty=1.2  # Reduce repetition
        )
        
        response_text = output['choices'][0]['text'].strip()
        
        print(f"[LLM] Generated {len(response_text)} characters", file=sys.stderr)
        
        return {
            "success": True,
            "response": response_text,
            "tokens_generated": output['usage']['completion_tokens']
        }
    except Exception as e:
        print(f"[LLM] Error generating: {e}", file=sys.stderr)
        return {"success": False, "error": str(e)}

def handle_command(cmd):
    """Handle a command from Electron"""
    global llm, model_path
    
    action = cmd.get('action')
    cmd_id = cmd.get('_id', 0)
    
    if action == 'load':
        model_path_arg = cmd.get('model_path')
        result = load_model(model_path_arg)
        result['_id'] = cmd_id
        return result
    
    elif action == 'generate':
        prompt = cmd.get('prompt', '')
        max_tokens = cmd.get('max_tokens', 500)
        temperature = cmd.get('temperature', 0.7)
        top_p = cmd.get('top_p', 0.9)
        top_k = cmd.get('top_k', 40)
        
        result = generate(prompt, max_tokens, temperature, top_p, top_k)
        result['_id'] = cmd_id
        return result
    
    elif action == 'unload':
        llm = None
        model_path = None
        result = {"success": True, "message": "Model unloaded"}
        result['_id'] = cmd_id
        return result
    
    else:
        result = {"success": False, "error": f"Unknown action: {action}"}
        result['_id'] = cmd_id
        return result

def main():
    """Main loop - read JSON commands from stdin, write responses to stdout"""
    print("[LLM] Service started, waiting for commands...", file=sys.stderr)
    
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        
        try:
            cmd = json.loads(line)
            result = handle_command(cmd)
            print(json.dumps(result), flush=True)
        except json.JSONDecodeError as e:
            error_result = {"success": False, "error": f"Invalid JSON: {e}"}
            print(json.dumps(error_result), flush=True)
        except Exception as e:
            error_result = {"success": False, "error": f"Unexpected error: {e}"}
            print(json.dumps(error_result), flush=True)

if __name__ == '__main__':
    main()
