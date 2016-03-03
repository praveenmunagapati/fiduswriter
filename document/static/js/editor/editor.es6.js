/* Functions for ProseMirror integration.*/

import {ProseMirror} from "prosemirror/dist/edit/main"
import {fromDOM} from "prosemirror/dist/format"
import {serializeTo} from "prosemirror/dist/format"
import {Step} from "prosemirror/dist/transform"
import "prosemirror/dist/collab"
//import "prosemirror/dist/menu/menubar"

import {fidusSchema} from "./es6_modules/schema"
import {updateUI} from "./es6_modules/update-ui"
import {ModComments} from "./es6_modules/comments/mod"
import {ModFootnotes} from "./es6_modules/footnotes/mod"

import {UpdateScheduler} from "prosemirror/dist/ui/update"

export class Editor {
    constructor() {
        this.mod = {}
        // Whether the editor is currently waiting for a document update. Set to true
        // initially so that diffs that arrive before document has been loaded are not
        // dealt with.
        this.waitingForDocument = true
        this.unconfirmedSteps = {}
        this.confirmStepsRequestCounter = 0
        this.collaborativeMode = false
        this.currentlyCheckingVersion = false
        this.awaitingDiffResponse = false
        this.receiving = false
        this.documentValues = {
            'sentHash': false,
            'rights': '',
            // In collaborative mode, only the first client to connect will have
            // theEditor.documentValues.control set to true.
            'control': false,
            'last_diffs': [],
            'is_owner': false,
            'is_new': false,
            'titleChanged': false,
            'changed': false
        }
        this.doc = {}
        this.user = false
        //this.init()
    }

    init() {
        let that = this
        this.pm = this.makeEditor(document.getElementById('document-editable'))
        new ModFootnotes(this)
        new UpdateScheduler(this.pm, "selectionChange change activeMarkChange blur focus setDoc", function() {
            updateUI(that)
        })
        this.pm.on("change", editorHelpers.documentHasChanged)
        this.pm.on("transform", (transform, options) => that.onTransform(transform, options))
        new UpdateScheduler(this.pm, "flush setDoc", mathHelpers.layoutEmptyEquationNodes)
        new UpdateScheduler(this.pm, "flush setDoc", mathHelpers.layoutEmptyDisplayEquationNodes)
        new UpdateScheduler(this.pm, "flush setDoc", citationHelpers.formatCitationsInDocIfNew)
    }

    makeEditor(where) {
        let pm = new ProseMirror({
            place: where,
            schema: fidusSchema,
            //    menuBar: true,
            collab: {
                version: 0
            }
        })
        pm.editor = this
        return pm
    }

    createDoc(aDocument) {
        let editorNode = document.createElement('div'),
            titleNode = aDocument.metadata.title ? exporter.obj2Node(aDocument.metadata.title) : document.createElement('div'),
            documentContentsNode = exporter.obj2Node(aDocument.contents),
            metadataSubtitleNode = aDocument.metadata.subtitle ? exporter.obj2Node(aDocument.metadata.subtitle) : document.createElement('div'),
            metadataAuthorsNode = aDocument.metadata.authors ? exporter.obj2Node(aDocument.metadata.authors) : document.createElement('div'),
            metadataAbstractNode = aDocument.metadata.abstract ? exporter.obj2Node(aDocument.metadata.abstract) : document.createElement('div'),
            metadataKeywordsNode = aDocument.metadata.keywords ? exporter.obj2Node(aDocument.metadata.keywords) : document.createElement('div'),
            doc

        titleNode.id = 'document-title'
        metadataSubtitleNode.id = 'metadata-subtitle'
        metadataAuthorsNode.id = 'metadata-authors'
        metadataAbstractNode.id = 'metadata-abstract'
        metadataKeywordsNode.id = 'metadata-keywords'
        documentContentsNode.id = 'document-contents'

        editorNode.appendChild(titleNode)
        editorNode.appendChild(metadataSubtitleNode)
        editorNode.appendChild(metadataAuthorsNode)
        editorNode.appendChild(metadataAbstractNode)
        editorNode.appendChild(metadataKeywordsNode)
        editorNode.appendChild(documentContentsNode)

        doc = fromDOM(fidusSchema, nodeConverter.modelToEditorNode(editorNode), {
            preserveWhitespace: true
        })
        return doc
    }

    update() {
        console.log('Updating editor')
        let that = this
        this.cancelCurrentlyCheckingVersion()
        this.unconfirmedSteps = {}
        if (this.awaitingDiffResponse) {
            this.enableDiffSending()
        }
        let doc = this.createDoc(this.doc)
        this.pm.setOption("collab", null)
        this.pm.setContent(doc)
        this.pm.setOption("collab", {
            version: this.doc.version
        })
        while (this.documentValues.last_diffs.length > 0) {
            let diff = this.documentValues.last_diffs.shift()
            this.applyDiff(diff)
        }
        this.doc.hash = this.getHash()
        this.pm.mod.collab.on("mustSend", function() {
            that.sendToCollaborators()
        })
        this.pm.signal("documentUpdated")
        new ModComments(this, this.doc.comment_version)
        _.each(this.doc.comments, function(comment) {
            this.mod.comments.store.addLocalComment(comment.id, comment.user,
                comment.userName, comment.userAvatar, comment.date, comment.comment,
                comment.answers, comment['review:isMajor'])
        })
        this.mod.comments.store.on("mustSend", function() {
            that.sendToCollaborators()
        })
        this.enableUI()
        this.waitingForDocument = false
    }



    askForDocument() {
        if (this.waitingForDocument) {
            return;
        }
        this.waitingForDocument = true
        serverCommunications.send({
            type: 'get_document'
        })
    }

    enableUI() {
        bibliographyHelpers.initiate()

        jQuery('.savecopy, .download, .latex, .epub, .html, .print, .style, \
      .citationstyle, .tools-item, .papersize, .metadata-menu-item, \
      #open-close-header').removeClass('disabled')

        citationHelpers.formatCitationsInDoc()
        editorHelpers.displaySetting.set('documentstyle')
        editorHelpers.displaySetting.set('citationstyle')

        jQuery('span[data-citationstyle=' + this.doc.settings.citationstyle +
            ']').addClass('selected')
        editorHelpers.displaySetting.set('papersize')

        editorHelpers.layoutMetadata()

        if (this.documentValues.rights === 'w') {
            jQuery('#editor-navigation').show()
            jQuery('.metadata-menu-item, #open-close-header, .save, \
          .multibuttonsCover, .papersize-menu, .metadata-menu, \
          .documentstyle-menu, .citationstyle-menu').removeClass('disabled')
            if (this.documentValues.is_owner) {
                // bind the share dialog to the button if the user is the document owner
                jQuery('.share').removeClass('disabled')
            }
            mathHelpers.resetMath()
        } else if (this.documentValues.rights === 'r') {
            // Try to disable contenteditable
            jQuery('.ProseMirror-content').attr('contenteditable', 'false')
        }
    }


    getUpdates(callback) {
        let outputNode = nodeConverter.editorToModelNode(serializeTo(this.pm.mod.collab.versionDoc, 'dom'))
        this.doc.title = this.pm.mod.collab.versionDoc.firstChild.textContent
        this.doc.version = this.pm.mod.collab.version
        this.doc.metadata.title = exporter.node2Obj(outputNode.getElementById('document-title'))
        this.doc.metadata.subtitle = exporter.node2Obj(outputNode.getElementById('metadata-subtitle'))
        this.doc.metadata.authors = exporter.node2Obj(outputNode.getElementById('metadata-authors'))
        this.doc.metadata.abstract = exporter.node2Obj(outputNode.getElementById('metadata-abstract'))
        this.doc.metadata.keywords = exporter.node2Obj(outputNode.getElementById('metadata-keywords'))
        this.doc.contents = exporter.node2Obj(outputNode.getElementById('document-contents'))
        this.doc.hash = this.getHash()
        this.doc.comments = this.mod.comments.store.comments
        if (callback) {
            callback()
        }
    }

    sendToCollaborators() {
        if (this.awaitingDiffResponse ||
            !this.pm.mod.collab.hasSendableSteps() &&
            this.mod.comments.store.unsentEvents().length === 0) {
            // We are waiting for the confirmation of previous steps, so don't
            // send anything now, or there is nothing to send.
            return
        }
        console.log('send to collabs')
        let toSend = this.pm.mod.collab.sendableSteps()
        let fnToSend = this.mod.footnotes.fnPm.mod.collab.sendableSteps()
        let request_id = this.confirmStepsRequestCounter++
            let aPackage = {
                type: 'diff',
                diff_version: this.pm.mod.collab.version,
                diff: toSend.steps.map(s => s.toJSON()),
                footnote_diff: fnToSend.steps.map(s => s.toJSON()),
                comments: this.mod.comments.store.unsentEvents(),
                comment_version: this.mod.comments.store.version,
                request_id: request_id,
                hash: this.getHash()
            }
        serverCommunications.send(aPackage)
        this.unconfirmedSteps[request_id] = {
            diffs: toSend,
            footnote_diffs: fnToSend,
            comments: this.mod.comments.store.hasUnsentEvents()
        }
        this.disableDiffSending()
    }

    receiveFromCollaborators(data) {
        let that = this
        if (this.waitingForDocument) {
            // We are currently waiting for a complete editor update, so
            // don't deal with incoming diffs.
            return
        }
        let editorHash = this.getHash()
        console.log('Incoming diff: version: '+data.diff_version+', hash: '+data.hash)
        console.log('Editor: version: '+theEditor.pm.mod.collab.version+', hash: '+editorHash)
        if (data.diff_version !== this.pm.mod.collab.version) {
            console.warn('Something is not correct. The local and remote versions do not match.')
            this.checkDiffVersion()
            return
        } else {
            console.log('version OK')
        }
        if (data.hash && data.hash !== editorHash) {
            console.warn('Something is not correct. The local and remote hash values do not match.')
            return false
        }
        if (data.comments && data.comments.length) {
            this.updateComments(data.comments, data.comments_version)
        }
        if (data.diff && data.diff.length) {
            data.diff.forEach(function(diff) {
                that.applyDiff(diff)
            })
        }
        if (data.footnote_diff && data.footnote_diff.length) {
            this.mod.footnotes.fnEditor.applyDiffs(data.footnote_diff)
        }
        if (data.reject_request_id) {
            this.rejectDiff(data.reject_request_id)
        }
        if (!data.hash) {
            // No hash means this must have been created server side.
            this.cancelCurrentlyCheckingVersion()
            this.enableDiffSending()
            // Because the uypdate came directly from the sevrer, we may
            // also have lost some collab updates to the footnote table.
            // Re-render the footnote table if needed.
            this.mod.footnotes.fnEditor.renderAllFootnotes()
        }
    }

    receiveDocument(data) {
        editorHelpers.copyDocumentValues(data.document, data.document_values)
        if (data.hasOwnProperty('user')) {
            this.user = data.user
        } else {
            this.user = this.doc.owner
        }
        usermediaHelpers.init(function(){
            theEditor.update()
            serverCommunications.send({
                type: 'participant_update'
            })
        })
    }

    // This client was participating in collaborative editing of this document
    // but not as the cleint that was in charge of saving. This has now changed
    // so that the current user is being asked to save the document.
    takeControl() {
        this.documentValues.control = true
        this.documentValues.sentHash = false
    }

    confirmDiff(request_id) {
        console.log('confirming steps')
        let sentSteps = this.unconfirmedSteps[request_id]["diffs"]
        this.pm.mod.collab.confirmSteps(sentSteps)

        let sentFnSteps = this.unconfirmedSteps[request_id]["footnote_diffs"]
        this.mod.footnotes.fnPm.mod.collab.confirmSteps(sentFnSteps)

        let sentComments = this.unconfirmedSteps[request_id]["comments"]
        this.mod.comments.store.eventsSent(sentComments)

        delete this.unconfirmedSteps[request_id]
        this.enableDiffSending()
    }

    rejectDiff(request_id) {
        console.log('rejecting steps')
        this.enableDiffSending()
        delete this.unconfirmedSteps[request_id]
        this.sendToCollaborators()
    }

    applyDiff(diff) {
        this.receiving = true
        let steps = [diff].map(j => Step.fromJSON(fidusSchema, j))
        let maps = this.pm.mod.collab.receive(steps)
        let unconfirmedMaps = this.pm.mod.collab.unconfirmedMaps
        maps = maps.concat(unconfirmedMaps)
        unconfirmedMaps.forEach(function(map) {
            // We add pseudo steps for all the unconfirmed steps so that the
            // unconfirmed maps will be applied when handling the transform
            steps.push({
                type: 'unconfirmed'
            })
        })
        let transform = {
            steps,
            maps
        }
        this.pm.signal("receivedTransform", transform)
        this.receiving = false
    }

    updateComments(comments, comment_version) {
        console.log('receiving comment update')
        this.mod.comments.store.receive(comments, comment_version)
    }

    getHash() {
        let string = JSON.stringify(this.pm.mod.collab.versionDoc)
        let len = string.length
        var hash = 0,
            char, i
        if (len == 0) return hash
        for (i = 0; i < len; i++) {
            char = string.charCodeAt(i)
            hash = ((hash << 5) - hash) + char
            hash = hash & hash
        }
        return hash
    }
    checkHash(version, hash) {
        console.log('Verifying hash')
        if (version === this.pm.mod.collab.version) {
            if (hash === this.getHash()) {
                console.log('Hash could be verified')
                return true
            }
            console.log('Hash could not be verified, requesting document.')
            this.disableDiffSending()
            this.askForDocument();
            return false
        } else {
            this.checkDiffVersion()
            return false
        }
    }

    cancelCurrentlyCheckingVersion() {
        this.currentlyCheckingVersion = false
        clearTimeout(this.enableCheckDiffVersion)
    }

    checkDiffVersion() {
        let that = this
        if (this.currentlyCheckingVersion) {
            return
        }
        this.currentlyCheckingVersion = true
        this.enableCheckDiffVersion = setTimeout(function() {
            that.currentlyCheckingVersion = false
        }, 1000)
        if (this.connected) {
            this.disableDiffSending()
        }
        serverCommunications.send({
            type: 'check_diff_version',
            diff_version: this.pm.mod.collab.version
        })
    }

    disableDiffSending() {
        let that = this
        this.awaitingDiffResponse = true
            // If no answer has been received from the server within 2 seconds, check the version
        this.checkDiffVersionTimer = setTimeout(function() {
            that.awaitingDiffResponse = false
            that.sendToCollaborators()
            that.checkDiffVersion()
        }, 2000)
    }

    enableDiffSending() {
        clearTimeout(this.checkDiffVersionTimer)
        this.awaitingDiffResponse = false
        this.sendToCollaborators()
    }

    // Things to be executed on every editor transform.
    onTransform(transform) {
        var updateBibliography = false
            // Check what area is affected
        transform.steps.forEach(function(step, index) {
            if (step.type === 'replace' && step.from.cmp(step.to) !== 0) {
                transform.docs[index].inlineNodesBetween(step.from, step.to, function(node) {
                    if (node.type.name === 'citation') {
                        // A citation was replaced
                        updateBibliography = true
                    }
                })
            }
        })

        if (updateBibliography) {
            // Recreate the bibliography on next flush.
            let formatCitations = new UpdateScheduler(this.pm, "flush", function() {
                formatCitations.detach()
                citationHelpers.formatCitationsInDoc()
            })
        }

    }

}

let theEditor = new Editor()

window.theEditor = theEditor
