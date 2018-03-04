import { inject, injectable, } from 'inversify';
import { ServiceIdentifiers } from './container/ServiceIdentifiers';

import * as escodegen from 'escodegen-wallaby';
import * as ESTree from 'estree';
import * as packageJson from 'pjson';

import { IGeneratorOutput } from './interfaces/IGeneratorOutput';
import { IJavaScriptObfuscator } from './interfaces/IJavaScriptObfsucator';
import { ILogger } from './interfaces/logger/ILogger';
import { IObfuscationResult } from './interfaces/IObfuscationResult';
import { IOptions } from './interfaces/options/IOptions';
import { IRandomGenerator } from './interfaces/utils/IRandomGenerator';
import { ISourceMapCorrector } from './interfaces/source-map/ISourceMapCorrector';
import { ITransformersRunner } from './interfaces/node-transformers/ITransformersRunner';

import { LoggingMessage } from './enums/logger/LoggingMessage';
import { NodeTransformer } from './enums/node-transformers/NodeTransformer';
import { TransformationStage } from './enums/node-transformers/TransformationStage';

import { EsprimaFacade } from './EsprimaFacade';
import { NodeGuards } from './node/NodeGuards';

@injectable()
export class JavaScriptObfuscator implements IJavaScriptObfuscator {
    /**
     * @type {GenerateOptions}
     */
    private static readonly escodegenParams: escodegen.GenerateOptions = {
        comment: true,
        verbatim: 'x-verbatim-property',
        sourceMapWithCode: true
    };

    /**
     * @type {NodeTransformer[]}
     */
    private static readonly transformersList: NodeTransformer[] = [
        NodeTransformer.BlockStatementControlFlowTransformer,
        NodeTransformer.ClassDeclarationTransformer,
        NodeTransformer.CommentsTransformer,
        NodeTransformer.CustomNodesTransformer,
        NodeTransformer.DeadCodeInjectionTransformer,
        NodeTransformer.EvalCallExpressionTransformer,
        NodeTransformer.FunctionControlFlowTransformer,
        NodeTransformer.CatchClauseTransformer,
        NodeTransformer.FunctionDeclarationTransformer,
        NodeTransformer.FunctionTransformer,
        NodeTransformer.LabeledStatementTransformer,
        NodeTransformer.LiteralTransformer,
        NodeTransformer.MemberExpressionTransformer,
        NodeTransformer.MethodDefinitionTransformer,
        NodeTransformer.ObfuscatingGuardsTransformer,
        NodeTransformer.ObjectExpressionKeysTransformer,
        NodeTransformer.ObjectExpressionTransformer,
        NodeTransformer.ParentificationTransformer,
        NodeTransformer.StringArrayTransformer,
        NodeTransformer.TemplateLiteralTransformer,
        NodeTransformer.VariableDeclarationTransformer
    ];

    /**
     * @type {ILogger}
     */
    private readonly logger: ILogger;

    /**
     * @type {IOptions}
     */
    private readonly options: IOptions;

    /**
     * @type {IRandomGenerator}
     */
    private readonly randomGenerator: IRandomGenerator;

    /**
     * @type {ISourceMapCorrector}
     */
    private readonly sourceMapCorrector: ISourceMapCorrector;

    /**
     * @type {ITransformersRunner}
     */
    private readonly transformersRunner: ITransformersRunner;

    /**
     * @param {ITransformersRunner} transformersRunner
     * @param {ISourceMapCorrector} sourceMapCorrector
     * @param {IRandomGenerator} randomGenerator
     * @param {ILogger} logger
     * @param {IOptions} options
     */
    constructor (
        @inject(ServiceIdentifiers.ITransformersRunner) transformersRunner: ITransformersRunner,
        @inject(ServiceIdentifiers.ISourceMapCorrector) sourceMapCorrector: ISourceMapCorrector,
        @inject(ServiceIdentifiers.IRandomGenerator) randomGenerator: IRandomGenerator,
        @inject(ServiceIdentifiers.ILogger) logger: ILogger,
        @inject(ServiceIdentifiers.IOptions) options: IOptions
    ) {
        this.transformersRunner = transformersRunner;
        this.sourceMapCorrector = sourceMapCorrector;
        this.randomGenerator = randomGenerator;
        this.logger = logger;
        this.options = options;
    }

    /**
     * @param {string} sourceCode
     * @returns {IObfuscationResult}
     */
    public obfuscate (sourceCode: string): IObfuscationResult {
        const timeStart: number = Date.now();
        this.logger.info(LoggingMessage.Version, packageJson.version);
        this.logger.info(LoggingMessage.ObfuscationStarted);
        this.logger.info(LoggingMessage.RandomGeneratorSeed, this.randomGenerator.getSeed());

        // parse AST tree
        const astTree: ESTree.Program = this.parseCode(sourceCode);

        // obfuscate AST tree
        const obfuscatedAstTree: ESTree.Program = this.transformAstTree(astTree);

        // generate code
        const generatorOutput: IGeneratorOutput = this.generateCode(sourceCode, obfuscatedAstTree);

        const obfuscationTime: number = (Date.now() - timeStart) / 1000;
        this.logger.success(LoggingMessage.ObfuscationCompleted, obfuscationTime);

        return this.getObfuscationResult(generatorOutput);
    }

    /**
     * @param {string} sourceCode
     * @returns {Program}
     */
    private parseCode (sourceCode: string): ESTree.Program {
        return EsprimaFacade.parse(sourceCode, {
            attachComment: true,
            loc: this.options.sourceMap
        });
    }

    /**
     * @param {Program} astTree
     * @returns {Program}
     */
    private transformAstTree (astTree: ESTree.Program): ESTree.Program {
        const isEmptyAstTree: boolean = NodeGuards.isProgramNode(astTree)
            && !astTree.body.length
            && !astTree.leadingComments;

        if (isEmptyAstTree) {
            this.logger.warn(LoggingMessage.EmptySourceCode);

            return astTree;
        }

        astTree = this.runTransformationStage(astTree, TransformationStage.Preparing);

        if (this.options.deadCodeInjection) {
            astTree = this.runTransformationStage(astTree, TransformationStage.DeadCodeInjection);
        }

        if (this.options.controlFlowFlattening) {
            astTree = this.runTransformationStage(astTree, TransformationStage.ControlFlowFlattening);
        }

        astTree = this.runTransformationStage(astTree, TransformationStage.Converting);
        astTree = this.runTransformationStage(astTree, TransformationStage.Obfuscating);
        astTree = this.runTransformationStage(astTree, TransformationStage.Finalizing);

        return astTree;
    }

    /**
     * @param {string} sourceCode
     * @param {Program} astTree
     * @returns {IGeneratorOutput}
     */
    private generateCode (sourceCode: string, astTree: ESTree.Program): IGeneratorOutput {
        const escodegenParams: escodegen.GenerateOptions = {
            ...JavaScriptObfuscator.escodegenParams
        };

        if (this.options.sourceMap) {
            escodegenParams.sourceMap = 'sourceMap';
            escodegenParams.sourceContent = sourceCode;
        }

        const generatorOutput: IGeneratorOutput = escodegen.generate(astTree, {
            ...escodegenParams,
            format: {
                compact: this.options.compact
            }
        });

        generatorOutput.map = generatorOutput.map ? generatorOutput.map.toString() : '';

        return generatorOutput;
    }

    /**
     * @param {IGeneratorOutput} generatorOutput
     * @returns {IObfuscationResult}
     */
    private getObfuscationResult (generatorOutput: IGeneratorOutput): IObfuscationResult {
        return this.sourceMapCorrector.correct(
            generatorOutput.code,
            generatorOutput.map
        );
    }

    /**
     * @param {Program} astTree
     * @param {TransformationStage} transformationStage
     * @returns {Program}
     */
    private runTransformationStage (astTree: ESTree.Program, transformationStage: TransformationStage): ESTree.Program {
        this.logger.info(LoggingMessage.TransformationStage, transformationStage);

        return this.transformersRunner.transform(
            astTree,
            JavaScriptObfuscator.transformersList,
            transformationStage
        );
    }
}
