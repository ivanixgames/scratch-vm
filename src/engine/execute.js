const BlockUtility = require('./block-utility');
const log = require('../util/log');
const Thread = require('./thread');
const {Map} = require('immutable');
const cast = require('../util/cast');

/**
 * Single BlockUtility instance reused by execute for every pritimive ran.
 * @const
 */
const blockUtility = new BlockUtility();

/**
 * Profiler frame name for block functions.
 * @const {string}
 */
const blockFunctionProfilerFrame = 'blockFunction';

/**
 * Profiler frame ID for 'blockFunction'.
 * @type {number}
 */
let blockFunctionProfilerId = -1;

/**
 * Utility function to determine if a value is a Promise.
 * @param {*} value Value to check for a Promise.
 * @return {boolean} True if the value appears to be a Promise.
 */
const isPromise = function (value) {
    return (
        value !== null &&
        typeof value === 'object' &&
        typeof value.then === 'function'
    );
};

const last = function (ary) {
    return ary[ary.length - 1];
};

/**
 * Handle any reported value from the primitive, either directly returned
 * or after a promise resolves.
 * @param {*} resolvedValue Value eventually returned from the primitive.
 * @param {!Sequencer} sequencer Sequencer stepping the thread for the ran
 * primitive.
 * @param {!Thread} thread Thread containing the primitive.
 * @param {!string} currentBlockId Id of the block in its thread for value from
 * the primitive.
 * @param {!string} opcode opcode used to identify a block function primitive.
 * @param {!boolean} isHat Is the current block a hat?
 */
// @todo move this to callback attached to the thread when we have performance
// metrics (dd)
const handleReport = function (
    resolvedValue, sequencer, thread, currentBlockId, opcode, isHat) {
    thread.pushReportedValue(resolvedValue);
    if (isHat === false) {
        // In a non-hat, report the value visually if necessary if
        // at the top of the thread stack.
        if (
            typeof resolvedValue !== 'undefined' &&
            thread.topBlock === last(thread.stack)
        ) {
            if (thread.stackClick) {
                sequencer.runtime.visualReport(currentBlockId, resolvedValue);
            }
            if (thread.updateMonitor) {
                const targetId = sequencer.runtime.monitorBlocks
                    .getBlock(currentBlockId).targetId;
                if (targetId && !sequencer.runtime.getTargetById(targetId)) {
                    // Target no longer exists
                    return;
                }
                sequencer.runtime.requestUpdateMonitor(Map({
                    id: currentBlockId,
                    spriteName: targetId ? sequencer.runtime.getTargetById(targetId).getName() : null,
                    value: String(resolvedValue)
                }));
            }
        }
        // Finished any yields.
        thread.status = Thread.STATUS_RUNNING;
    } else {
        // Hat predicate was evaluated.
        if (sequencer.runtime.getIsEdgeActivatedHat(opcode)) {
            // If this is an edge-activated hat, only proceed if the value is
            // true and used to be false, or the stack was activated explicitly
            // via stack click
            if (!thread.stackClick) {
                const oldEdgeValue = sequencer.runtime.updateEdgeActivatedValue(
                    currentBlockId,
                    resolvedValue
                );
                const edgeWasActivated = !oldEdgeValue && resolvedValue;
                if (!edgeWasActivated) {
                    sequencer.retireThread(thread);
                }
            }
        } else if (!resolvedValue) {
            // Not an edge-activated hat: retire the thread
            // if predicate was false.
            sequencer.retireThread(thread);
        }
    }
};

const opcodeInfo = (function() {
    const infoCache = {};

    return function (opcode, runtime) {
        if (typeof infoCache[opcode] === 'object') {
            return infoCache[opcode];
        }

        const blockFunction = runtime.getOpcodeFunction(opcode);
        infoCache[opcode] = {
            opcode,
            isHat: runtime.getIsHat(opcode),
            blockFunction,
            isEdgeActivated: runtime.getIsEdgeActivatedHat(opcode),
            hasBlockFunction: typeof blockFunction !== 'undefined',
            fieldKeys: null
        };
        return infoCache[opcode];
    };
})();

/**
 * Execute a block.
 * @param {!Sequencer} sequencer Which sequencer is executing.
 * @param {!Thread} thread Thread which to read and execute.
 */
const execute = function (sequencer, thread) {
    const runtime = sequencer.runtime;
    const target = thread.target;

    // Current block to execute is the one on the top of the stack.
    const currentBlockId = thread.peekStack();
    const currentStackFrame = thread.peekStackFrame();

    let blockContainer = thread.blockContainer;
    // if (thread.updateMonitor) {
    //     blockContainer = runtime.monitorBlocks;
    // } else {
    //     blockContainer = target.blocks;
    // }
    let block = blockContainer.getBlock(currentBlockId);
    if (typeof block === 'undefined') {
        blockContainer = runtime.flyoutBlocks;
        block = blockContainer.getBlock(currentBlockId);
        // Stop if block or target no longer exists.
        if (typeof block === 'undefined') {
            // No block found: stop the thread; script no longer exists.
            sequencer.retireThread(thread);
            return;
        }
    }

    const opcode = blockContainer.getOpcode(block);

    if (typeof opcode !== 'string') {
        log.warn(`Could not get opcode for block: ${currentBlockId}`);
        return;
    }

    const _info = opcodeInfo(opcode, runtime);
    const {hasBlockFunction, blockFunction, isHat} = _info;
    // const blockFunction = runtime.getOpcodeFunction(opcode);
    // const isHat = runtime.getIsHat(opcode);

    const inputs = blockContainer.getInputs(block);

    // Hats and single-field shadows are implemented slightly differently
    // from regular blocks.
    // For hats: if they have an associated block function,
    // it's treated as a predicate; if not, execution will proceed as a no-op.
    // For single-field shadows: If the block has a single field, and no inputs,
    // immediately return the value of the field.
    if (!hasBlockFunction) {
        if (isHat) {
            // Skip through the block (hat with no predicate).
            return;
        }
        if (blockContainer.isShadow(block)) {
            // One field and no inputs - treat as arg.
            handleReport(blockContainer.getShadowValue(block), sequencer, thread, currentBlockId, opcode, isHat);
        // }
        // const keys = Object.keys(fields);
        // if (
        //     _info.singleFieldShadow ||
        //     keys.length === 1 && Object.keys(inputs).length === 0
        // ) {
        //     _info.singleFieldShadow = true;
        //     // One field and no inputs - treat as arg.
        //     handleReport(fields[keys[0]].value, sequencer, thread, currentBlockId, opcode, isHat);
        } else {
            log.warn(`Could not get implementation for opcode: ${opcode}`);
        }
        thread.requestScriptGlowInFrame = true;
        return;
    }

    // Generate values for arguments (inputs).
    const argValues = {};

    const idNameField = blockContainer.getIdNameField(block);
    if (idNameField === null) {
        const fields = blockContainer.getFields(block);
        // Add all fields on this block to the argValues.
        for (const fieldName in fields) {
            argValues[fieldName] = fields[fieldName].value;
        }
    } else {
        argValues[idNameField.name] = idNameField.value;
    }

    // Recursively evaluate input blocks.
    for (const inputName in inputs) {
        if (
            inputs.hasOwnProperty(inputName) &&
            // Do not evaluate the internal custom command block within
            // definition
            inputName !== 'custom_block'
        ) {
            const input = inputs[inputName];
            const inputBlockId = input.block;
            // Is there no value for this input waiting in the stack frame?
            if (
                inputBlockId !== null &&
                typeof currentStackFrame.reported[inputName] === 'undefined'
            ) {
                // If there's not, we need to evaluate the block.
                // Push to the stack to evaluate the reporter block.
                thread.pushStack(inputBlockId);
                // Save name of input for `Thread.pushReportedValue`.
                currentStackFrame.waitingReporter = inputName;
                // Actually execute the block.
                execute(sequencer, thread);
                if (thread.status !== Thread.STATUS_PROMISE_WAIT) {
                    // Execution returned immediately,
                    // and presumably a value was reported, so pop the stack.
                    currentStackFrame.waitingReporter = null;
                    thread.popStack();
                } else {
                    return;
                }
            }
            const inputValue = currentStackFrame.reported[inputName];
            if (inputName !== 'BROADCAST_INPUT') {
                argValues[inputName] = inputValue;
            } else {
                const broadcastInput = inputs[inputName];
                // Check if something is plugged into the broadcast block, or
                // if the shadow dropdown menu is being used.
                if (broadcastInput.block === broadcastInput.shadow) {
                    // Shadow dropdown menu is being used.
                    // Get the appropriate information out of it.
                    const shadow = blockContainer.getBlock(broadcastInput.shadow);
                    const broadcastField = shadow.fields.BROADCAST_OPTION;
                    argValues.BROADCAST_OPTION = {
                        id: broadcastField.id,
                        name: broadcastField.value
                    };
                } else {
                    // Something is plugged into the broadcast input.
                    // Cast it to a string. We don't need an id here.
                    argValues.BROADCAST_OPTION = {
                        name: cast.toString(inputValue)
                    };
                }
            }
        }
    }

    // Add any mutation to args (e.g., for procedures).
    const mutation = blockContainer.getMutation(block);
    if (mutation !== null) {
        argValues.mutation = mutation;
    }

    // If we've gotten this far, all of the input blocks are evaluated,
    // and `argValues` is fully populated. So, execute the block primitive.
    // First, clear `currentStackFrame.reported`, so any subsequent execution
    // (e.g., on return from a branch) gets fresh inputs.
    currentStackFrame.reported = {};

    let primitiveReportedValue = null;
    blockUtility.sequencer = sequencer;
    blockUtility.thread = thread;
    if (runtime.profiler !== null) {
        if (blockFunctionProfilerId === -1) {
            blockFunctionProfilerId = runtime.profiler.idByName(blockFunctionProfilerFrame);
        }
        // The method commented below has its code inlined underneath to reduce
        // the bias recorded for the profiler's calls in this time sensitive
        // execute function.
        //
        // runtime.profiler.start(blockFunctionProfilerId, opcode);
        runtime.profiler.records.push(
            runtime.profiler.START, blockFunctionProfilerId, opcode, performance.now());
    }
    primitiveReportedValue = blockFunction(argValues, blockUtility);
    if (runtime.profiler !== null) {
        // runtime.profiler.stop(blockFunctionProfilerId);
        runtime.profiler.records.push(runtime.profiler.STOP, performance.now());
    }

    if (typeof primitiveReportedValue === 'undefined') {
        // No value reported - potentially a command block.
        // Edge-activated hats don't request a glow; all commands do.
        thread.requestScriptGlowInFrame = true;
    }

    // If it's a promise, wait until promise resolves.
    if (isPromise(primitiveReportedValue)) {
        if (thread.status === Thread.STATUS_RUNNING) {
            // Primitive returned a promise; automatically yield thread.
            thread.status = Thread.STATUS_PROMISE_WAIT;
        }
        // Promise handlers
        primitiveReportedValue.then(resolvedValue => {
            handleReport(resolvedValue, sequencer, thread, currentBlockId, opcode, isHat);
            if (typeof resolvedValue === 'undefined') {
                let stackFrame;
                let nextBlockId;
                do {
                    // In the case that the promise is the last block in the current thread stack
                    // We need to pop out repeatedly until we find the next block.
                    const popped = thread.popStack();
                    if (popped === null) {
                        return;
                    }
                    nextBlockId = thread.target.blocks.getNextBlock(popped);
                    if (nextBlockId !== null) {
                        // A next block exists so break out this loop
                        break;
                    }
                    // Investigate the next block and if not in a loop,
                    // then repeat and pop the next item off the stack frame
                    stackFrame = thread.peekStackFrame();
                } while (stackFrame !== null && !stackFrame.isLoop);

                thread.pushStack(nextBlockId);
            } else {
                thread.popStack();
            }
        }, rejectionReason => {
            // Promise rejected: the primitive had some error.
            // Log it and proceed.
            log.warn('Primitive rejected promise: ', rejectionReason);
            thread.status = Thread.STATUS_RUNNING;
            thread.popStack();
        });
    } else if (thread.status === Thread.STATUS_RUNNING) {
        handleReport(primitiveReportedValue, sequencer, thread, currentBlockId, opcode, isHat);
    }
};

module.exports = execute;
